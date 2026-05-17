import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { ToolRegistryEntry, ToolResultStatus, TokenUsage } from "../types.js";
import { randomInt } from "node:crypto";
import { getSubtaskPolicy, type SubtaskType } from "./subtask-policy.js";

export type AgentProfileSource = "user" | "project" | "builtin";
export type AgentProfileMode = "readonly" | "write_patch" | "write_worktree";
export type AgentProfileApproval = "fail" | "disabled";
export type AgentProfileToolPreset = "readonly" | "none" | "explicit";

export interface AgentProfileTools {
  preset: AgentProfileToolPreset;
  include?: string[];
  exclude?: string[];
}

export interface AgentProfile {
  name: string;
  description: string;
  source: AgentProfileSource;
  filePath?: string;
  mode: AgentProfileMode;
  model?: string | "inherit";
  tools: AgentProfileTools;
  maxTurns?: number;
  approval: AgentProfileApproval;
  nicknameCandidates?: string[];
  prompt: string;
  subtaskType?: SubtaskType;
}

export interface SubagentRunResult {
  subAgentId: string;
  agentName: string;
  nickname?: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  profileSource: AgentProfileSource;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export interface DiscoverAgentProfilesResult {
  profiles: AgentProfile[];
  projectAgentsDir: string | null;
  diagnostics: string[];
}

export interface AgentProfileDiagnostic {
  severity: "warning" | "error";
  message: string;
  toolName?: string;
}

const READONLY_PRESET = [
  "read",
  "glob",
  "grep",
  "lsp",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_read_summary",
  "skill",
  "todo_write",
];

const SUBAGENT_DENY_TOOLS = new Set(["subagent", "task", "spawn_agent", "wait_agent", "send_input", "close_agent"]);

const DEFAULT_NICKNAME_CANDIDATES = [
  "Ada",
  "Alan",
  "Grace",
  "Katherine",
  "Claude",
  "Edsger",
  "Barbara",
  "Donald",
  "Margaret",
  "Ken",
  "Radia",
  "Leslie",
  "Mary",
  "Dennis",
  "Frances",
  "Niklaus",
  "Jean",
  "Linus",
  "Anita",
  "Yukihiro",
  "Brenda",
  "Guido",
  "Sophie",
  "Tim",
  "Hedy",
  "John",
  "Evelyn",
  "Bjarne",
  "Karen",
  "Vint",
  "Adele",
  "Fernando",
];

export type AgentProfileScope = "user" | "project" | "both";

export function discoverAgentProfiles(cwd: string, scope: AgentProfileScope = "user"): DiscoverAgentProfilesResult {
  const diagnostics: string[] = [];
  const profiles: AgentProfile[] = [...builtinAgentProfiles()];
  const userDir = join(getBubbleHome(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  if (scope !== "project") {
    profiles.push(...loadProfilesFromDir(userDir, "user", diagnostics));
  }
  if (scope !== "user" && projectAgentsDir) {
    profiles.push(...loadProfilesFromDir(projectAgentsDir, "project", diagnostics));
  }

  const map = new Map<string, AgentProfile>();
  for (const profile of profiles) {
    map.set(profile.name, profile);
  }

  return {
    profiles: [...map.values()],
    projectAgentsDir,
    diagnostics,
  };
}

export function builtinAgentProfiles(): AgentProfile[] {
  const toProfile = (type: SubtaskType): AgentProfile => {
    const policy = getSubtaskPolicy(type);
    return {
      name: `builtin:${type}`,
      description: `${type} read-only subagent`,
      source: "builtin",
      mode: "readonly",
      model: "inherit",
      tools: {
        preset: "explicit",
        include: [...policy.allowedTools],
        exclude: [],
      },
      approval: "fail",
      nicknameCandidates: DEFAULT_NICKNAME_CANDIDATES,
      prompt: policy.reminder,
      subtaskType: type,
    };
  };

  const roleProfile = (
    name: string,
    description: string,
    prompt: string,
    include: string[] = READONLY_PRESET,
  ): AgentProfile => ({
    name,
    description,
    source: "builtin",
    mode: "readonly",
    model: "inherit",
    tools: {
      preset: "explicit",
      include,
      exclude: [],
    },
    approval: "fail",
    nicknameCandidates: DEFAULT_NICKNAME_CANDIDATES,
    prompt,
  });

  return [
    roleProfile(
      "default",
      "General read-only subagent",
      [
        "You are a focused child agent. Complete the assigned task independently using only read-only tools.",
        "Return a concise result with concrete evidence, file paths, and any uncertainty.",
        "Do not ask the user questions. If blocked by policy or missing data, state the blocker plainly.",
      ].join("\n"),
    ),
    roleProfile(
      "explorer",
      "Fast codebase exploration subagent",
      [
        "You are an explorer subagent for codebase reconnaissance.",
        "Answer the specific question by inspecting the repository directly. Prefer precise file paths and line-level evidence.",
        "Keep the answer compact and avoid broad refactors or implementation plans unless asked.",
      ].join("\n"),
      ["read", "glob", "grep", "lsp", "memory_search", "memory_read_summary", "skill", "todo_write"],
    ),
    roleProfile(
      "worker",
      "Implementation-planning worker subagent",
      [
        "You are a worker subagent. In this Phase 1 runtime you are read-only, so you must not modify files.",
        "Analyze the assigned implementation slice, identify exact files to change, and return a concrete patch plan or findings.",
        "If write-capable worker mode is needed, say so explicitly.",
      ].join("\n"),
      ["read", "glob", "grep", "lsp", "memory_search", "memory_read_summary", "skill", "todo_write"],
    ),
    toProfile("search"),
    toProfile("security_investigation"),
    toProfile("evidence_correlation"),
    toProfile("general_readonly"),
  ];
}

export function findAgentProfile(profiles: AgentProfile[], name: string): AgentProfile | undefined {
  return profiles.find((profile) => profile.name === name)
    ?? profiles.find((profile) => profile.name === `builtin:${name}`);
}

export function assignAgentNickname(profile: AgentProfile, activeNicknames: Iterable<string> = []): string {
  const active = new Set([...activeNicknames].map((item) => item.toLowerCase()));
  const candidates = (profile.nicknameCandidates && profile.nicknameCandidates.length > 0
    ? profile.nicknameCandidates
    : DEFAULT_NICKNAME_CANDIDATES)
    .map((item) => item.trim())
    .filter(Boolean);
  const available = candidates.filter((item) => !active.has(item.toLowerCase()));
  const pool = available.length > 0 ? available : candidates;
  if (pool.length === 0) {
    return `Agent-${randomInt(1000, 9999)}`;
  }
  return pool[randomInt(pool.length)];
}

export function selectToolsForAgentProfile(
  tools: ToolRegistryEntry[],
  profile: AgentProfile,
  approval: AgentProfileApproval = profile.approval,
): ToolRegistryEntry[] {
  const explicitInclude = new Set(profile.tools.include ?? []);
  const selected = requestedToolNames(profile);
  for (const tool of SUBAGENT_DENY_TOOLS) selected.delete(tool);

  const out: ToolRegistryEntry[] = [];
  for (const tool of tools) {
    if (!selected.has(tool.name)) continue;
    if (SUBAGENT_DENY_TOOLS.has(tool.name)) continue;
    if ((tool.effect ?? "unknown") !== "read") continue;
    if (tool.deferred && !explicitInclude.has(tool.name)) continue;
    if (approval === "disabled" && tool.requiresApproval) continue;
    out.push(wrapApprovalFailTool(tool, approval));
  }
  return out;
}

export function validateAgentProfileTools(
  tools: ToolRegistryEntry[],
  profile: AgentProfile,
  approval: AgentProfileApproval = profile.approval,
): AgentProfileDiagnostic[] {
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const explicitInclude = new Set(profile.tools.include ?? []);
  const diagnostics: AgentProfileDiagnostic[] = [];
  for (const name of requestedToolNames(profile)) {
    if (SUBAGENT_DENY_TOOLS.has(name)) {
      diagnostics.push({
        severity: "error",
        toolName: name,
        message: `Tool "${name}" is not allowed inside subagents because recursive delegation is disabled in Phase 1.`,
      });
      continue;
    }

    const tool = available.get(name);
    if (!tool) {
      if (explicitInclude.has(name)) {
        diagnostics.push({
          severity: "warning",
          toolName: name,
          message: `Tool "${name}" is listed by profile "${profile.name}" but is not available in this session.`,
        });
      }
      continue;
    }

    const effect = tool.effect ?? "unknown";
    if (effect !== "read") {
      diagnostics.push({
        severity: "error",
        toolName: name,
        message: `Tool "${name}" has effect "${effect}" and cannot run in Phase 1 read-only subagents.`,
      });
    } else if (approval === "disabled" && tool.requiresApproval) {
      diagnostics.push({
        severity: "warning",
        toolName: name,
        message: `Tool "${name}" requires approval and will be removed because approval is disabled for this subagent.`,
      });
    }
  }
  return diagnostics;
}

export function mergeUsage(current: SubagentRunResult["usage"], usage: TokenUsage): SubagentRunResult["usage"] {
  const promptTokens = (current?.promptTokens ?? 0) + usage.promptTokens;
  const completionTokens = (current?.completionTokens ?? 0) + usage.completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function wrapApprovalFailTool(tool: ToolRegistryEntry, approval: AgentProfileApproval): ToolRegistryEntry {
  if (approval !== "fail" || !tool.requiresApproval) return tool;
  return {
    ...tool,
    execute: async () => ({
      content: `Blocked: tool "${tool.name}" requires interactive approval, which is disabled for subagents.`,
      isError: true,
      status: "blocked" as ToolResultStatus,
      metadata: {
        kind: "security",
        reason: "Subagents cannot request interactive approval.",
      },
    }),
  };
}

function requestedToolNames(profile: AgentProfile): Set<string> {
  const selected = new Set<string>();
  if (profile.tools.preset === "readonly") {
    for (const tool of READONLY_PRESET) selected.add(tool);
  } else if (profile.tools.preset === "explicit") {
    for (const tool of profile.tools.include ?? []) selected.add(tool);
  }
  for (const tool of profile.tools.include ?? []) selected.add(tool);
  for (const tool of profile.tools.exclude ?? []) selected.delete(tool);
  return selected;
}

function loadProfilesFromDir(dir: string, source: AgentProfileSource, diagnostics: string[]): AgentProfile[] {
  if (!existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (error: any) {
    diagnostics.push(`Failed to read agent profile directory ${dir}: ${error.message || String(error)}`);
    return [];
  }

  const profiles: AgentProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      if (!statSync(filePath).isFile()) continue;
      const parsed = parseAgentProfileFile(readFileSync(filePath, "utf8"), source, filePath);
      if (parsed) profiles.push(parsed);
    } catch (error: any) {
      diagnostics.push(`Failed to load agent profile ${filePath}: ${error.message || String(error)}`);
    }
  }
  return profiles;
}

function parseAgentProfileFile(raw: string, source: AgentProfileSource, filePath: string): AgentProfile | undefined {
  const parsed = splitFrontmatter(raw);
  if (!parsed) return undefined;
  const frontmatter = parseProfileFrontmatter(parsed.frontmatter);
  const fallbackName = filePath.split("/").pop()?.replace(/\.md$/, "") ?? "agent";
  const name = stringValue(frontmatter.name) || fallbackName;
  const description = stringValue(frontmatter.description);
  if (!name || !description) return undefined;

  return {
    name,
    description,
    source,
    filePath,
    mode: modeValue(frontmatter.mode),
    model: stringValue(frontmatter.model) || "inherit",
    tools: toolsValue(frontmatter.tools),
    maxTurns: numberValue(frontmatter.maxTurns),
    approval: approvalValue(frontmatter.approval),
    nicknameCandidates: stringArray(frontmatter.nicknameCandidates) ?? stringArray(frontmatter.nicknames),
    prompt: parsed.body.trim(),
  };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } | undefined {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  return {
    frontmatter: normalized.slice(4, end),
    body: normalized.slice(end + 5),
  };
}

function parseProfileFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.trim()) {
      out[key] = parseScalar(value.trim());
      continue;
    }
    i++;
    const listItems: string[] = [];
    for (; i < lines.length; i++) {
      const itemLine = lines[i];
      if (!itemLine.startsWith("  - ")) {
        i--;
        break;
      }
      const item = itemLine.slice("  - ".length).trim();
      if (item) listItems.push(String(parseScalar(item)));
    }
    if (listItems.length > 0) {
      out[key] = listItems;
      continue;
    }
    const nested: Record<string, unknown> = {};
    i++;
    for (; i < lines.length; i++) {
      const nestedLine = lines[i];
      if (!nestedLine.startsWith("  ")) {
        i--;
        break;
      }
      const nestedMatch = nestedLine.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (nestedMatch) {
        const nestedKey = nestedMatch[1];
        const nestedValue = nestedMatch[2].trim();
        if (nestedValue) {
          nested[nestedKey] = parseScalar(nestedValue);
          continue;
        }
        const items: string[] = [];
        i++;
        for (; i < lines.length; i++) {
          const itemLine = lines[i];
          if (!itemLine.startsWith("    - ")) {
            i--;
            break;
          }
          const item = itemLine.slice("    - ".length).trim();
          if (item) items.push(String(parseScalar(item)));
        }
        nested[nestedKey] = items.length > 0 ? items : "";
      }
    }
    out[key] = nested;
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (!value) return "";
  const unquoted = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    return unquoted.slice(1, -1).split(",").map((item) => String(parseScalar(item.trim()))).filter(Boolean);
  }
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+$/.test(unquoted)) return Number.parseInt(unquoted, 10);
  return unquoted;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modeValue(value: unknown): AgentProfileMode {
  return value === "write_patch" || value === "write_worktree" ? value : "readonly";
}

function approvalValue(value: unknown): AgentProfileApproval {
  return value === "disabled" ? "disabled" : "fail";
}

function toolsValue(value: unknown): AgentProfileTools {
  if (typeof value === "string") {
    if (value === "none" || value === "explicit" || value === "readonly") return { preset: value };
    return { preset: "explicit", include: [value] };
  }
  if (Array.isArray(value)) {
    return { preset: "explicit", include: stringArray(value) ?? [] };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const preset = raw.preset === "none" || raw.preset === "explicit" || raw.preset === "readonly"
      ? raw.preset
      : "readonly";
    return {
      preset,
      include: stringArray(raw.include),
      exclude: stringArray(raw.exclude),
    };
  }
  return { preset: "readonly", include: [], exclude: [] };
}

function stringArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".bubble", "agents");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // ignore
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
