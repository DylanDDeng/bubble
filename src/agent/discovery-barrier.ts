import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ContentPart, ParsedToolCall, ToolResult, ToolResultMetadata } from "../types.js";
import { analyzeToolIntent } from "./tool-intent.js";
import { resolveToolPath } from "../tools/path-utils.js";

export interface DiscoveryBarrierOptions {
  cwd: string;
  input: string | ContentPart[];
  enabled: boolean;
}

export class DiscoveryBarrier {
  private readonly cwd: string;
  private readonly enabled: boolean;
  private readonly knownPaths = new Set<string>();
  private readonly userMentionedPaths = new Set<string>();

  constructor(options: DiscoveryBarrierOptions) {
    this.cwd = options.cwd;
    this.enabled = options.enabled;
    for (const path of extractUserMentionedPaths(options.input)) {
      this.userMentionedPaths.add(canonicalPath(this.cwd, path));
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  shouldBufferStreamingToolCall(name: string): boolean {
    return this.enabled && (name === "read" || name === "bash" || name === "lsp");
  }

  orderToolCalls<T extends ParsedToolCall>(toolCalls: T[]): T[] {
    if (!this.enabled || toolCalls.length < 2) return toolCalls;
    const discovery: T[] = [];
    const rest: T[] = [];
    for (const toolCall of toolCalls) {
      if (isDiscoveryToolCall(toolCall)) discovery.push(toolCall);
      else rest.push(toolCall);
    }
    if (discovery.length === 0 || rest.length === 0) return toolCalls;
    return [...discovery, ...rest];
  }

  beforeToolCall(toolCall: ParsedToolCall): ToolResult | undefined {
    if (!this.enabled) return undefined;
    const target = pathSensitiveReadTarget(toolCall);
    if (!target) return undefined;

    const canonical = canonicalPath(this.cwd, target.path);
    if (this.knownPaths.has(canonical) || this.userMentionedPaths.has(canonical)) return undefined;

    return {
      content:
        `Blocked speculative ${target.kind}. The path "${target.path}" has not been discovered in this repository context ` +
        "and was not explicitly requested by the user. Run glob/grep/lsp discovery first, then read only returned paths. " +
        "Do not infer from this blocked call whether the path exists.",
      isError: true,
      status: "blocked",
      metadata: {
        kind: "internal",
        reason: "speculative_read_blocked",
        hiddenFromTranscript: true,
        path: canonical,
        requestedPath: target.path,
        toolName: toolCall.name,
      },
    };
  }

  afterToolCall(toolCall: ParsedToolCall, result: ToolResult): void {
    if (!this.enabled || result.metadata?.hiddenFromTranscript === true) return;
    this.observeMetadata(result.metadata);

    if (isSuccessfulAccessResult(result)) {
      const target = pathSensitiveReadTarget(toolCall);
      if (target) this.knownPaths.add(canonicalPath(this.cwd, target.path));
    }
  }

  observeMetadata(metadata: ToolResultMetadata | undefined): void {
    if (!metadata) return;
    for (const path of metadataPaths(metadata)) {
      this.knownPaths.add(canonicalPath(this.cwd, path));
    }
  }
}

export function isHiddenToolResult(result: ToolResult | undefined): result is ToolResult {
  return result?.metadata?.hiddenFromTranscript === true;
}

export function isHiddenToolMetadata(metadata: ToolResultMetadata | undefined): boolean {
  return metadata?.hiddenFromTranscript === true;
}

function isDiscoveryToolCall(toolCall: ParsedToolCall): boolean {
  if (toolCall.name === "glob" || toolCall.name === "grep") return true;
  return analyzeToolIntent(toolCall).family === "search";
}

function pathSensitiveReadTarget(toolCall: ParsedToolCall): { kind: "read" | "bash read" | "lsp"; path: string } | undefined {
  if (toolCall.name === "read") {
    const path = stringArg(toolCall.parsedArgs.path ?? toolCall.parsedArgs.file);
    return path ? { kind: "read", path } : undefined;
  }

  if (toolCall.name === "bash") {
    const intent = analyzeToolIntent(toolCall);
    const path = intent.read?.path;
    return path ? { kind: "bash read", path } : undefined;
  }

  if (toolCall.name === "lsp") {
    const path = stringArg(toolCall.parsedArgs.filePath);
    return path ? { kind: "lsp", path } : undefined;
  }

  return undefined;
}

function metadataPaths(metadata: ToolResultMetadata): string[] {
  const paths = new Set<string>();
  addPathValue(paths, metadata.path);
  addPathValue(paths, metadata.paths);
  return [...paths];
}

function addPathValue(out: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    out.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.add(item);
  }
}

function isSuccessfulAccessResult(result: ToolResult): boolean {
  return !result.isError
    && result.status !== "blocked"
    && result.status !== "cancelled"
    && result.status !== "command_error"
    && result.status !== "timeout";
}

function canonicalPath(cwd: string, value: string): string {
  const absolute = resolveToolPath(cwd, value);
  try {
    if (existsSync(absolute)) return realpathSync.native(absolute);
  } catch {
    // Fall back to lexical resolution for unreadable or racing paths.
  }
  return resolve(absolute);
}

function extractUserMentionedPaths(input: string | ContentPart[]): string[] {
  const text = typeof input === "string"
    ? input
    : input
      .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");

  const paths = new Set<string>();
  const regex = /(?:^|[\s`'"])(~?\.{0,2}\/[^\s`'"]+|[\w@.-]+\.[A-Za-z0-9][\w.-]*)(?=$|[\s`'",.;:!?，。；：！？）)])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value && isLikelyFilePath(value)) paths.add(stripTrailingPunctuation(value));
  }
  return [...paths];
}

function isLikelyFilePath(value: string): boolean {
  const stripped = stripTrailingPunctuation(value);
  if (stripped.startsWith("./") || stripped.startsWith("../") || stripped.startsWith("~/") || stripped.startsWith("/")) {
    return true;
  }
  return /\.[A-Za-z0-9][\w.-]*$/.test(basename(stripped));
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?，。；：！？）)]+$/u, "");
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
