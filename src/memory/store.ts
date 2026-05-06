import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHomeInfo, type BubbleEnvironment } from "../bubble-home.js";
import { MemoryDatabase, type MemoryJob } from "./db.js";
import { getMemoryPaths, type MemoryPaths } from "./paths.js";
import { buildReadPathPrompt } from "./prompts.js";

export type MemoryScope = "global" | "project";
export type MemorySearchScope = MemoryScope | "all";

export interface MemoryStatus {
  paths: MemoryPaths;
  bubbleHome: string;
  environment: BubbleEnvironment;
  files: Array<{ label: string; path: string; exists: boolean; bytes: number }>;
  database: {
    path: string;
    stage1Outputs: number;
    disabledThreads: number;
    jobs: MemoryJob[];
  };
}

export interface MemorySearchResult {
  scope: MemoryScope;
  path: string;
  line: number;
  text: string;
}

const MAX_PROMPT_FILE_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 12;

export function buildMemoryPrompt(cwd: string): string | undefined {
  const paths = getMemoryPaths(cwd);
  const sections: string[] = [];

  addFileSection(sections, "Global AGENTS.md", paths.globalAgents);
  addFileSection(sections, "Project AGENTS.md", paths.projectAgents);
  addFileSection(sections, "Project .bubble/AGENTS.md", paths.projectLocalAgents);

  const memorySummary = readOptional(paths.globalSummary)?.trim();

  if (sections.length === 0 && !memorySummary) {
    return undefined;
  }

  const memoryPrompt = memorySummary
    ? buildReadPathPrompt({ memoryRoot: paths.globalRoot, memorySummary })
    : undefined;

  return [...sections, memoryPrompt].filter(Boolean).join("\n\n");
}

export function getMemoryStatus(cwd: string): MemoryStatus {
  const paths = getMemoryPaths(cwd);
  const bubbleHome = getBubbleHomeInfo();
  const files = [
    { label: "global AGENTS.md", path: paths.globalAgents },
    { label: "global memory_summary.md", path: paths.globalSummary },
    { label: "global MEMORY.md", path: paths.globalMemory },
    { label: "global raw_memories.md", path: paths.globalRawMemories },
    { label: "global state.sqlite", path: paths.globalDatabase },
    { label: "project AGENTS.md", path: paths.projectAgents },
    { label: "project .bubble/AGENTS.md", path: paths.projectLocalAgents },
  ].map((item) => {
    const content = readOptional(item.path);
    return {
      ...item,
      exists: content !== undefined,
      bytes: content?.length ?? 0,
    };
  });

  const db = new MemoryDatabase(cwd);
  try {
    const stats = db.stats();
    return {
      paths,
      bubbleHome: bubbleHome.home,
      environment: bubbleHome.environment,
      files,
      database: {
        path: paths.globalDatabase,
        ...stats,
      },
    };
  } finally {
    db.close();
  }
}

export function searchMemory(
  cwd: string,
  query: string,
  options: { scope?: MemorySearchScope; limit?: number } = {},
): MemorySearchResult[] {
  const paths = getMemoryPaths(cwd);
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const scope = options.scope ?? "all";
  const files: Array<{ scope: MemoryScope; path: string }> = [
    ...(scope === "global" || scope === "all" ? [
      { scope: "global" as const, path: paths.globalSummary },
      { scope: "global" as const, path: paths.globalMemory },
      { scope: "global" as const, path: paths.globalRawMemories },
    ] : []),
    ...(scope === "project" || scope === "all" ? [
      { scope: "project" as const, path: paths.globalSummary },
      { scope: "project" as const, path: paths.globalMemory },
      { scope: "project" as const, path: paths.globalRawMemories },
    ] : []),
  ];
  const seenFiles = new Set<string>();
  const results: MemorySearchResult[] = [];
  const limit = options.limit ?? MAX_SEARCH_RESULTS;

  for (const file of files) {
    if (seenFiles.has(file.path)) continue;
    seenFiles.add(file.path);
    const content = readOptional(file.path);
    if (!content) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.toLowerCase().includes(normalized)) continue;
      results.push({
        scope: file.scope,
        path: file.path,
        line: index + 1,
        text: collapseWhitespace(line).slice(0, 220),
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }

  for (const rollout of listRolloutSummaryFiles(paths.globalRolloutSummaries)) {
    const content = readOptional(rollout);
    if (!content) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.toLowerCase().includes(normalized)) continue;
      results.push({
        scope: "global",
        path: rollout,
        line: index + 1,
        text: collapseWhitespace(line).slice(0, 220),
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

export function readMemorySummary(cwd: string, scope: MemorySearchScope = "project"): Array<{ scope: MemoryScope; path: string; content: string }> {
  const paths = getMemoryPaths(cwd);
  const files: Array<{ scope: MemoryScope; path: string }> = [
    ...(scope === "global" || scope === "all" ? [{ scope: "global" as const, path: paths.globalSummary }] : []),
    ...(scope === "project" || scope === "all" ? [{ scope: "project" as const, path: paths.globalSummary }] : []),
  ];
  return files
    .map((file) => ({ ...file, content: readOptional(file.path)?.trim() ?? "" }))
    .filter((file) => file.content);
}

function listRolloutSummaryFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .reverse()
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

function addFileSection(sections: string[], label: string, path: string): void {
  const content = readOptional(path)?.trim();
  if (!content) return;
  sections.push(`### ${label}\nPath: ${path}\n\n${truncate(content, MAX_PROMPT_FILE_CHARS)}`);
}

function readOptional(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 80).trimEnd()}\n\n[truncated ${value.length - maxChars + 80} chars]`;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function redactSecrets(value: string): { text: string; redacted: boolean } {
  const patterns = [
    /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
    /\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    /\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi,
  ];
  let text = value;
  let redacted = false;
  for (const pattern of patterns) {
    text = text.replace(pattern, (...args) => {
      redacted = true;
      if (args.length > 2 && typeof args[1] === "string" && args[1].match(/[:=]\s*$/)) {
        return `${args[1]}[REDACTED_SECRET]`;
      }
      return "[REDACTED_SECRET]";
    });
  }
  return { text, redacted };
}
