import os from "node:os";
import type { DisplayToolCall } from "./display-history.js";
import { getEditDiffDetails } from "./edit-diff.js";
import { formatSubagentRoute, type SubagentRouteLike } from "../agent/subagent-route-format.js";

export type TraceGroupKind =
  | "list"
  | "read"
  | "search"
  | "execute"
  | "edit"
  | "write"
  | "subagent"
  | "other";

export interface TraceGroup {
  kind: TraceGroupKind;
  title: string;
  raw: DisplayToolCall[];
  count?: number;
  noun?: string;
  command?: string;
  items: string[];
  previewLines: string[];
  errorLines: string[];
  omitted: number;
  pending: boolean;
  hasError: boolean;
  errorCount: number;
  startedAt?: number;
}

interface TraceClassifier {
  kind: TraceGroupKind;
  title: string;
  bucketKey: string;
  groupable: boolean;
}

export interface TraceGroupOptions {
  maxItems?: number;
  maxPreviewLines?: number;
  homeDir?: string;
}

const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_MAX_PREVIEW_LINES = 8;

export function buildTraceGroups(
  toolCalls: DisplayToolCall[],
  options: TraceGroupOptions = {},
): TraceGroup[] {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxPreviewLines = options.maxPreviewLines ?? DEFAULT_MAX_PREVIEW_LINES;
  const homeDir = options.homeDir ?? os.homedir();
  const groups: TraceGroup[] = [];
  let bucket: DisplayToolCall[] = [];
  let bucketClassifier: TraceClassifier | null = null;

  const flush = () => {
    if (bucket.length === 0 || !bucketClassifier) return;
    groups.push(buildTraceGroup(bucketClassifier, bucket, {
      maxItems,
      maxPreviewLines,
      homeDir,
    }));
    bucket = [];
    bucketClassifier = null;
  };

  for (const toolCall of toolCalls) {
    const classifier = classifyTool(toolCall);
    if (!classifier.groupable) {
      flush();
      groups.push(buildTraceGroup(classifier, [toolCall], {
        maxItems,
        maxPreviewLines,
        homeDir,
      }));
      continue;
    }

    if (bucketClassifier?.bucketKey === classifier.bucketKey) {
      bucket.push(toolCall);
    } else {
      flush();
      bucket = [toolCall];
      bucketClassifier = classifier;
    }
  }

  flush();
  return groups;
}

export function formatTracePath(value: unknown, homeDir = os.homedir()): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text === homeDir) return "~";
  if (text.startsWith(homeDir + "/")) return "~" + text.slice(homeDir.length);
  return text;
}

export function formatElapsed(startedAt: number | undefined, now = Date.now()): string | null {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

export function traceGroupLabel(group: TraceGroup): string {
  if (group.command) return `${group.title} ${group.command}`;
  if (group.count !== undefined && group.noun) return `${group.title} ${group.count} ${group.noun}`;
  return group.title;
}

function classifyTool(toolCall: DisplayToolCall): TraceClassifier {
  if (toolCall.metadata?.kind === "subagent") {
    return { kind: "subagent", title: "Subagents", bucketKey: `subagent:${toolCall.id}`, groupable: false };
  }

  switch (toolCall.name) {
    case "glob": {
      const pattern = String(toolCall.args.pattern ?? "");
      const title = isDirectoryLikeGlob(pattern) ? "List Directory" : "Find Files";
      return {
        kind: "list",
        title,
        bucketKey: `list:${title}`,
        groupable: true,
      };
    }
    case "read":
      return { kind: "read", title: "Read", bucketKey: "read", groupable: true };
    case "grep":
      return { kind: "search", title: "Search", bucketKey: "search", groupable: true };
    case "bash":
      return { kind: "execute", title: "Execute", bucketKey: `execute:${toolCall.id}`, groupable: false };
    case "edit":
      return { kind: "edit", title: "Edit", bucketKey: `edit:${toolCall.id}`, groupable: false };
    case "write":
      return { kind: "write", title: "Write", bucketKey: "write", groupable: true };
    default:
      return {
        kind: "other",
        title: displayToolName(toolCall.name),
        bucketKey: `${toolCall.name}:${toolCall.id}`,
        groupable: false,
      };
  }
}

function buildTraceGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
): TraceGroup {
  const pending = raw.some((tool) => isToolPending(tool));
  const startedAt = raw
    .filter((tool) => isToolPending(tool))
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
  const hasError = raw.some((tool) => !!tool.isError);
  const errorCount = raw.filter((tool) => !!tool.isError).length;

  switch (classifier.kind) {
    case "list":
      return buildListGroup(classifier, raw, options, pending, startedAt, hasError, errorCount);
    case "read":
      return buildPathGroup(classifier, raw, options, pending, startedAt, hasError, errorCount, "files");
    case "search":
      return buildSearchGroup(classifier, raw, options, pending, startedAt, hasError, errorCount);
    case "execute":
      return buildExecuteGroup(classifier, raw[0]!, options, pending, startedAt, hasError, errorCount);
    case "edit":
    case "write":
      return buildMutationGroup(classifier, raw, options, pending, startedAt, hasError, errorCount);
    case "subagent":
      return buildSubagentGroup(classifier, raw[0]!, options, pending, startedAt);
    default:
      return buildOtherGroup(classifier, raw, options, pending, startedAt, hasError, errorCount);
  }
}

function buildListGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
): TraceGroup {
  const resultItems = raw.flatMap((tool) => resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir)));
  const fallbackItems = raw
    .map((tool) => String(tool.args.pattern ?? tool.args.path ?? "").trim())
    .filter(Boolean)
    .map((item) => formatTracePath(item, options.homeDir));
  const sourceItems = resultItems.length > 0 ? resultItems : fallbackItems;
  const { shown, omitted } = take(sourceItems, options.maxItems);
  const count = resultItems.length > 0 ? resultItems.length : sourceItems.length || raw.length;
  const noun = resultItems.length > 0 ? plural(count, "file", "files") : plural(count, "search", "searches");

  return {
    kind: "list",
    title: classifier.title,
    raw,
    count,
    noun,
    items: shown,
    previewLines: [],
    errorLines: collectErrorLines(raw, options),
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

function buildPathGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
  nounBase: string,
): TraceGroup {
  const items = unique(raw
    .map((tool) => formatTracePath(tool.args.path ?? tool.args.file ?? "", options.homeDir))
    .filter(Boolean));
  const { shown, omitted } = take(items, options.maxItems);
  const count = items.length || raw.length;
  return {
    kind: classifier.kind,
    title: classifier.title,
    raw,
    count,
    noun: plural(count, nounBase.slice(0, -1), nounBase),
    items: shown,
    previewLines: [],
    errorLines: collectErrorLines(raw, options),
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

function buildSearchGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
): TraceGroup {
  const items = raw.map((tool) => {
    const pattern = String(tool.args.pattern ?? tool.args.query ?? "").trim();
    const scope = String(tool.args.path ?? tool.args.glob ?? tool.args.include ?? "").trim();
    const patternText = pattern ? `"${pattern}"` : "(pattern)";
    return scope ? `${patternText} in ${formatTracePath(scope, options.homeDir)}` : patternText;
  });
  const { shown, omitted } = take(items, options.maxItems);
  const count = raw.length;
  return {
    kind: "search",
    title: classifier.title,
    raw,
    count,
    noun: plural(count, "search", "searches"),
    items: shown,
    previewLines: [],
    errorLines: collectErrorLines(raw, options),
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

function buildExecuteGroup(
  classifier: TraceClassifier,
  tool: DisplayToolCall,
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
): TraceGroup {
  const lines = resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir));
  const { shown, omitted } = take(lines, options.maxPreviewLines);
  return {
    kind: "execute",
    title: classifier.title,
    raw: [tool],
    command: normalizeCommand(tool.args.command ?? tool.args.cmd ?? commandFromRawArguments(tool.rawArguments)),
    items: [],
    previewLines: shown,
    errorLines: [],
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

function buildMutationGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
): TraceGroup {
  const items = raw
    .map((tool) => {
      const path = formatTracePath(tool.args.path ?? firstMetadataPath(tool) ?? "", options.homeDir);
      const details = tool.name === "edit" || tool.name === "apply_patch" ? getEditDiffDetails(tool) : null;
      const suffix = details ? ` ${formatCompactEditStats(details.added, details.removed)}` : "";
      return path ? `${path}${suffix}` : "";
    })
    .filter(Boolean);
  const { shown, omitted } = take(items, options.maxItems);
  const count = items.length || raw.length;
  const errorPreview = hasError
    ? raw
      .filter((tool) => tool.isError)
      .flatMap((tool) => resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir)))
      .slice(0, options.maxPreviewLines)
    : [];
  return {
    kind: classifier.kind,
    title: classifier.title,
    raw,
    count,
    noun: plural(count, "file", "files"),
    items: shown,
    previewLines: errorPreview,
    errorLines: [],
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

interface SubagentTraceItem {
  subAgentId?: string;
  agentName?: string;
  nickname?: string;
  status?: string;
  category?: string;
  route?: SubagentRouteLike;
  task?: string;
  summary?: string;
  toolNotes?: string[];
  error?: string;
}

function buildSubagentGroup(
  classifier: TraceClassifier,
  tool: DisplayToolCall,
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
): TraceGroup {
  const subagents = subagentsFromMetadata(tool);
  const rows = subagents.length > 0
    ? subagents.map(formatSubagentRow)
    : resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir));
  const { shown, omitted } = take(rows, options.maxPreviewLines);
  const errorCount = subagents.filter(isFailedSubagent).length + (tool.isError ? 1 : 0);

  return {
    kind: "subagent",
    title: classifier.title,
    raw: [tool],
    count: subagents.length || 1,
    noun: plural(subagents.length || 1, "agent", "agents"),
    items: [],
    previewLines: shown,
    errorLines: [],
    omitted,
    pending: pending || subagents.some((subagent) => ["queued", "running"].includes(subagent.status ?? "running")),
    hasError: !!tool.isError || errorCount > 0,
    errorCount,
    startedAt,
  };
}

function buildOtherGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
  errorCount: number,
): TraceGroup {
  const tool = raw[0]!;
  const header = toolHeader(tool, options.homeDir);
  const preview = resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir));
  const { shown, omitted } = take(preview, options.maxPreviewLines);
  return {
    kind: "other",
    title: classifier.title,
    raw,
    count: header ? undefined : raw.length,
    noun: header ? undefined : plural(raw.length, "call", "calls"),
    items: header ? [header] : [],
    previewLines: shown,
    errorLines: [],
    omitted,
    pending,
    hasError,
    errorCount,
    startedAt,
  };
}

function subagentsFromMetadata(tool: DisplayToolCall): SubagentTraceItem[] {
  const raw = tool.metadata?.subagents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SubagentTraceItem => typeof item === "object" && item !== null);
}

function formatSubagentRow(subagent: SubagentTraceItem): string {
  const label = subagent.nickname || subagent.agentName || subagent.subAgentId || "subagent";
  const role = [subagent.agentName, subagent.category ? `/${subagent.category}` : ""].join("") || "default";
  const route = formatSubagentRoute(subagent.route);
  const descriptor = route ? `${role} @ ${route}` : role;
  const status = subagent.status || "running";
  const note = subagent.error
    || subagent.toolNotes?.filter(Boolean).at(-1)
    || subagent.summary
    || subagent.task
    || "";
  return [label, `(${descriptor})`, status, note].filter(Boolean).join(" ");
}

function isFailedSubagent(subagent: SubagentTraceItem): boolean {
  return subagent.status === "failed" || subagent.status === "blocked" || subagent.status === "cancelled";
}

function isToolPending(tool: DisplayToolCall): boolean {
  return tool.result === undefined && tool.resultCollapsed !== true;
}

function isDirectoryLikeGlob(pattern: string): boolean {
  const normalized = pattern.trim();
  return normalized === "" || normalized === "*" || normalized === "**" || normalized === "**/*";
}

function resultLines(result: string | undefined): string[] {
  if (result === undefined) return [];
  return result
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

function take(items: string[], max: number): { shown: string[]; omitted: number } {
  const shown = items.slice(0, max);
  return { shown, omitted: Math.max(0, items.length - shown.length) };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function collectErrorLines(raw: DisplayToolCall[], options: Required<TraceGroupOptions>): string[] {
  return raw
    .filter((tool) => tool.isError)
    .flatMap((tool) => resultLines(tool.result).map((line) => formatTraceLine(line, options.homeDir)))
    .slice(0, options.maxPreviewLines);
}

function formatTraceLine(value: unknown, homeDir: string): string {
  const text = String(value ?? "").trimEnd();
  if (!homeDir) return text;
  return text.split(homeDir + "/").join("~/").split(homeDir).join("~");
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function normalizeCommand(value: unknown): string {
  const command = String(value ?? "").replace(/\s+/g, " ").trim();
  return command;
}

function commandFromRawArguments(rawArguments: string | undefined): string {
  if (!rawArguments) return "";
  try {
    const parsed = JSON.parse(rawArguments);
    if (parsed && typeof parsed === "object") {
      const command = (parsed as Record<string, unknown>).command ?? (parsed as Record<string, unknown>).cmd;
      return typeof command === "string" ? command : "";
    }
  } catch {
    const match = rawArguments.match(/"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (match?.[1]) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1];
      }
    }
  }
  return "";
}

function displayToolName(name: string): string {
  if (!name) return "Tool";
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
}

function toolHeader(tool: DisplayToolCall, homeDir: string): string | undefined {
  const args = tool.args || {};
  for (const key of ["path", "command", "pattern", "query", "url"]) {
    const value = args[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return formatTracePath(value, homeDir);
    }
  }
  const path = firstMetadataPath(tool);
  if (path) return formatTracePath(path, homeDir);
  return undefined;
}

function firstMetadataPath(tool: DisplayToolCall): string | undefined {
  const paths = tool.metadata?.paths;
  return Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : undefined;
}

function formatCompactEditStats(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.length > 0 ? `(${parts.join(" ")})` : "";
}
