/**
 * Transcript visibility of tool results.
 *
 * `hiddenFromTranscript` is a general mechanism: a hook may block a tool call
 * and mark the exchange hidden so it never reaches the model's transcript or
 * the UI. These helpers are the canonical way to test for it.
 */
import type { ToolResult, ToolResultMetadata } from "../types.js";

export function isHiddenToolResult(result: ToolResult | undefined): result is ToolResult {
  return result?.metadata?.hiddenFromTranscript === true;
}

export function isHiddenToolMetadata(metadata: ToolResultMetadata | undefined): boolean {
  return metadata?.hiddenFromTranscript === true;
}
