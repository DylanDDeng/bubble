// Tool-output bounding for both live results and restored session history.
//
// A provider-declared token cap is useful when present, but it cannot be the
// only guard: several providers (including GLM coding-plan models) declare no
// per-tool limit at all. Every model-visible tool result therefore has a hard
// byte ceiling as well. The stricter of the two policies wins.

import { getToolOutputTokenLimit } from "../model-catalog.js";
import type { ToolResult } from "../types.js";
import { estimateTextTokens } from "./budget.js";

export const DEFAULT_TOOL_OUTPUT_BYTE_LIMIT = 64 * 1024;
export const TOOL_OUTPUT_BATCH_BYTE_LIMIT = 160 * 1024;

export interface ToolTruncationOptions {
  /** Override used by a sibling tool batch to divide its aggregate budget. */
  hardByteLimit?: number;
}

export interface ToolTruncationResult {
  content: string;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
  originalBytes: number;
  finalBytes: number;
  /** Provider/model-declared token cap, when one exists. */
  limit: number | undefined;
  hardByteLimit: number;
}

export function truncateToolOutputForModel(
  content: string,
  providerId: string,
  modelId: string,
  options: ToolTruncationOptions = {},
): ToolTruncationResult {
  const limit = getToolOutputTokenLimit(providerId, modelId);
  const hardByteLimit = Math.max(0, Math.floor(options.hardByteLimit ?? DEFAULT_TOOL_OUTPUT_BYTE_LIMIT));
  const originalTokens = estimateTextTokens(content, providerId);
  const originalBytes = Buffer.byteLength(content, "utf8");

  if (originalBytes <= hardByteLimit && (!limit || originalTokens <= limit)) {
    return {
      content,
      truncated: false,
      originalTokens,
      finalTokens: originalTokens,
      originalBytes,
      finalBytes: originalBytes,
      limit,
      hardByteLimit,
    };
  }

  if (hardByteLimit === 0) {
    return {
      content: "",
      truncated: content.length > 0,
      originalTokens,
      finalTokens: 0,
      originalBytes,
      finalBytes: 0,
      limit,
      hardByteLimit,
    };
  }

  // Start with the byte ceiling. If a token policy is tighter, use the
  // observed token/byte ratio to choose a smaller first candidate.
  let candidateByteBudget = hardByteLimit;
  if (limit && originalTokens > limit) {
    candidateByteBudget = Math.min(
      candidateByteBudget,
      Math.max(1, Math.floor(originalBytes * (limit / originalTokens) * 0.9)),
    );
  }

  let truncated = middleTruncateToByteBudget(
    content,
    candidateByteBudget,
    buildMarker(originalBytes, hardByteLimit, limit),
  );

  // Token estimation varies across providers and scripts. Tighten until both
  // invariants hold; byte truncation itself is UTF-8 safe on every pass.
  for (let pass = 0; pass < 8 && limit && estimateTextTokens(truncated, providerId) > limit; pass++) {
    const tokens = estimateTextTokens(truncated, providerId);
    candidateByteBudget = Math.max(
      1,
      Math.floor(candidateByteBudget * (limit / Math.max(1, tokens)) * 0.9),
    );
    truncated = middleTruncateToByteBudget(
      content,
      candidateByteBudget,
      buildMarker(originalBytes, hardByteLimit, limit),
    );
  }

  // Extremely small model caps may not even fit the descriptive marker.
  // Continue shrinking deterministically rather than violating the contract.
  while (limit && estimateTextTokens(truncated, providerId) > limit && truncated.length > 0) {
    candidateByteBudget = Math.max(0, Math.floor(candidateByteBudget * 0.75));
    truncated = middleTruncateToByteBudget(
      content,
      candidateByteBudget,
      buildMarker(originalBytes, hardByteLimit, limit),
    );
  }

  const finalTokens = estimateTextTokens(truncated, providerId);
  const finalBytes = Buffer.byteLength(truncated, "utf8");
  return {
    content: truncated,
    truncated: true,
    originalTokens,
    finalTokens,
    originalBytes,
    finalBytes,
    limit,
    hardByteLimit,
  };
}

export function normalizeToolResultForModel(
  result: ToolResult,
  providerId: string,
  modelId: string,
  options: ToolTruncationOptions = {},
): ToolResult {
  const bounded = truncateToolOutputForModel(result.content, providerId, modelId, options);
  if (!bounded.truncated) return result;

  return {
    ...result,
    content: bounded.content,
    metadata: {
      ...result.metadata,
      truncated: true,
      toolOutputTruncation: {
        originalBytes: bounded.originalBytes,
        finalBytes: bounded.finalBytes,
        originalTokens: bounded.originalTokens,
        finalTokens: bounded.finalTokens,
        hardByteLimit: bounded.hardByteLimit,
        ...(bounded.limit ? { modelTokenLimit: bounded.limit } : {}),
      },
    },
  };
}

function buildMarker(originalBytes: number, hardByteLimit: number, tokenLimit?: number): string {
  const policy = tokenLimit
    ? `${formatBytes(hardByteLimit)} hard cap; ${tokenLimit}-token model cap`
    : `${formatBytes(hardByteLimit)} hard cap`;
  return `\n\n[... middle of ${formatBytes(originalBytes)} output truncated by model policy (${policy}) ...]\n\n`;
}

function middleTruncateToByteBudget(content: string, byteBudget: number, marker: string): string {
  if (byteBudget <= 0) return "";
  if (Buffer.byteLength(content, "utf8") <= byteBudget) return content;

  let safeMarker = marker;
  if (Buffer.byteLength(safeMarker, "utf8") > byteBudget) {
    safeMarker = utf8Prefix(safeMarker, byteBudget);
  }
  const markerBytes = Buffer.byteLength(safeMarker, "utf8");
  const payloadBytes = Math.max(0, byteBudget - markerBytes);
  const headBudget = Math.floor(payloadBytes / 2);
  const tailBudget = payloadBytes - headBudget;
  const head = utf8Prefix(content, headBudget);
  const tail = utf8Suffix(content, tailBudget);
  return `${head}${safeMarker}${tail}`;
}

/** Return the longest prefix that fits without splitting a Unicode code point. */
export function utf8Prefix(content: string, maxBytes: number): string {
  if (maxBytes <= 0 || content.length === 0) return "";
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const safeMid = isLowSurrogateAt(content, mid) ? mid - 1 : mid;
    if (Buffer.byteLength(content.slice(0, safeMid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = Math.min(low, content.length);
  if (isLowSurrogateAt(content, end)) end -= 1;
  while (end > 0 && Buffer.byteLength(content.slice(0, end), "utf8") > maxBytes) end -= 1;
  if (isLowSurrogateAt(content, end)) end -= 1;
  return content.slice(0, Math.max(0, end));
}

/** Return the longest suffix that fits without splitting a Unicode code point. */
export function utf8Suffix(content: string, maxBytes: number): string {
  if (maxBytes <= 0 || content.length === 0) return "";
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    let start = content.length - length;
    if (isLowSurrogateAt(content, start)) start += 1;
    if (Buffer.byteLength(content.slice(start), "utf8") <= maxBytes) low = length;
    else high = length - 1;
  }
  let start = Math.max(0, content.length - low);
  if (isLowSurrogateAt(content, start)) start += 1;
  while (start < content.length && Buffer.byteLength(content.slice(start), "utf8") > maxBytes) start += 1;
  if (isLowSurrogateAt(content, start)) start += 1;
  return content.slice(Math.min(start, content.length));
}

function isLowSurrogateAt(content: string, index: number): boolean {
  if (index <= 0 || index >= content.length) return false;
  const code = content.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count}B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)}KiB`;
  return `${(count / (1024 * 1024)).toFixed(2)}MiB`;
}
