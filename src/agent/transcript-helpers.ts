/**
 * Transcript-level helpers: interrupted-run boundaries, the cancelled-tool
 * sentinel, required-arg validation and the subagent-lifecycle tool-name
 * predicate used when forking context for children.
 */
import type { Message, ToolResult } from "../types.js";
import { summarizeInterruptError } from "./abort-errors.js";

export function findMissingRequiredArgs(
  schema: { required?: string[] } | undefined,
  args: Record<string, any> | undefined,
): string[] {
  const required = schema?.required;
  if (!required || required.length === 0) return [];
  const missing: string[] = [];
  for (const name of required) {
    const value = args ? args[name] : undefined;
    // Empty strings/arrays are intentionally allowed — writing an empty file
    // or passing an empty list can be legitimate. Only undefined/null counts
    // as "missing", because the observed failure mode is `finalArgs: "{}"`
    // where the field is entirely absent.
    if (value === undefined || value === null) {
      missing.push(name);
    }
  }
  return missing;
}

export function shouldAppendModelInterruptedBoundary(messages: Message[]): boolean {
  return messages.at(-1)?.role === "tool";
}

export function createModelInterruptedMessage(
  error: unknown,
  metadata: { model: string; providerId: string; modelId: string },
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: `[model request interrupted before a final answer was produced: ${summarizeInterruptError(error)}]`,
    model: metadata.model,
    providerId: metadata.providerId,
    modelId: metadata.modelId,
  };
}

export function lastProviderMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "system" || message.role === "meta") continue;
    return message;
  }
  return undefined;
}

export function cancelledToolResult(toolName: string): ToolResult {
  return {
    content: `Tool "${toolName}" was cancelled.`,
    isError: true,
    status: "cancelled",
    metadata: { reason: "cancelled" },
  };
}

export function isSubagentLifecycleTool(name: string): boolean {
  return name === "subagent"
    || name === "spawn_agent"
    || name === "wait_agent"
    || name === "send_input"
    || name === "close_agent"
    || name === "list_agents"
    || name === "run_workflow"
    || name === "wait_workflow"
    // Legacy names: still present in transcripts recorded before the tools
    // were removed (2026-07-06); forked children must not inherit their
    // dangling tool_calls either.
    || name === "agent_team"
    || name === "agent_batch";
}
