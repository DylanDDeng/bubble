import os from "node:os";
import type { DisplayToolCall } from "./display-history.js";
import { getEditDiffDetails } from "./edit-diff.js";

export type TraceGroupKind =
  | "list"
  | "read"
  | "search"
  | "execute"
  | "edit"
  | "write"
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
  omitted: number;
  pending: boolean;
  hasError: boolean;
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

  switch (classifier.kind) {
    case "list":
      return buildListGroup(classifier, raw, options, pending, startedAt, hasError);
    case "read":
      return buildPathGroup(classifier, raw, options, pending, startedAt, hasError, "files");
    case "search":
      return buildSearchGroup(classifier, raw, options, pending, startedAt, hasError);
    case "execute":
      return buildExecuteGroup(classifier, raw[0]!, options, pending, startedAt, hasError);
    case "edit":
    case "write":
      return buildMutationGroup(classifier, raw, options, pending, startedAt, hasError);
    default:
      return buildOtherGroup(classifier, raw, options, pending, startedAt, hasError);
  }
}

function buildListGroup(
  classifier: TraceClassifier,
  raw: DisplayToolCall[],
  options: Required<TraceGroupOptions>,
  pending: boolean,
  startedAt: number | undefined,
  hasError: boolean,
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
    omitted,
    pending,
    hasError,
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
  nounBase: string,
): TraceGroup {
  const items = raw
    .map((tool) => formatTracePath(tool.args.path ?? tool.args.file ?? "", options.homeDir))
    .filter(Boolean);
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
    omitted,
    pending,
    hasError,
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
    omitted,
    pending,
    hasError,
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
): TraceGroup {
  const lines = resultLines(tool.result).map((line) => formatTracePath(line, options.homeDir));
  const { shown, omitted } = take(lines, options.maxPreviewLines);
  return {
    kind: "execute",
    title: classifier.title,
    raw: [tool],
    command: normalizeCommand(tool.args.command ?? ""),
    items: [],
    previewLines: shown,
    omitted,
    pending,
    hasError,
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
): TraceGroup {
  const items = raw
    .map((tool) => {
      const path = formatTracePath(tool.args.path ?? "", options.homeDir);
      const details = tool.name === "edit" ? getEditDiffDetails(tool) : null;
      const suffix = details ? ` ${formatCompactEditStats(details.added, details.removed)}` : "";
      return path ? `${path}${suffix}` : "";
    })
    .filter(Boolean);
  const { shown, omitted } = take(items, options.maxItems);
  const count = items.length || raw.length;
  return {
    kind: classifier.kind,
    title: classifier.title,
    raw,
    count,
    noun: plural(count, "file", "files"),
    items: shown,
    previewLines: [],
    omitted,
    pending,
    hasError,
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
    omitted,
    pending,
    hasError,
    startedAt,
  };
}

function isToolPending(tool: DisplayToolCall): boolean {
  return tool.result === undefined;
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

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function normalizeCommand(value: unknown): string {
  const command = String(value ?? "").replace(/\s+/g, " ").trim();
  return command || "(command)";
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
  return undefined;
}

function formatCompactEditStats(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.length > 0 ? `(${parts.join(" ")})` : "";
}
