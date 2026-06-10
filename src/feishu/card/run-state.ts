/**
 * Pure-function reducer: AgentEvent → RunState.
 *
 * Mutates `state` in place for performance (this runs on every streaming
 * token). Always sets state.updatedAt. Caller is expected to immediately
 * re-render through the (throttled) card renderer.
 */

import type { AgentEvent, PermissionMode, TokenUsage } from "../../types.js";
import type { RunState, ToolBlock, TextBlock, ThinkingBlock } from "./run-state-types.js";

const TOOL_ARGS_PREVIEW_LIMIT = 120;
const TOOL_RESULT_PREVIEW_LIMIT = 800;
const TEXT_BLOCK_MAX_CHARS = 12_000;
const THINKING_BLOCK_MAX_CHARS = 4_000;

export function reduceRunState(state: RunState, event: AgentEvent): RunState {
  state.updatedAt = Date.now();

  switch (event.type) {
    case "turn_start":
      // No state change — just signals a new LLM round trip.
      return state;

    case "text_delta": {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === "text" && last.streaming) {
        last.text = appendBounded(last.text, event.content, TEXT_BLOCK_MAX_CHARS);
      } else {
        closeStreamingBlocks(state);
        const block: TextBlock = {
          kind: "text",
          text: appendBounded("", event.content, TEXT_BLOCK_MAX_CHARS),
          streaming: true,
        };
        state.blocks.push(block);
      }
      return state;
    }

    case "reasoning_delta": {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === "thinking" && last.streaming) {
        last.text = appendBounded(last.text, event.content, THINKING_BLOCK_MAX_CHARS);
      } else {
        closeStreamingBlocks(state);
        const block: ThinkingBlock = {
          kind: "thinking",
          text: appendBounded("", event.content, THINKING_BLOCK_MAX_CHARS),
          streaming: true,
        };
        state.blocks.push(block);
      }
      return state;
    }

    case "tool_call_start":
    case "tool_call_delta":
    case "tool_call_end":
      // Args streaming is noisy; we wait for `tool_start` (parsed args) before
      // creating the visible tool block.
      return state;

    case "tool_start": {
      closeStreamingBlocks(state);
      const block: ToolBlock = {
        kind: "tool",
        id: event.id,
        name: event.name,
        argsPreview: formatArgsPreview(event.args),
        status: "running",
        startedAt: Date.now(),
      };
      state.blocks.push(block);
      return state;
    }

    case "tool_update":
      // Subagent updates carry rich child events; render as nested status
      // tweak (status flips to "running" for queued→running). We keep it
      // minimal in v1 — the parent tool block reflects high-level state.
      return state;

    case "tool_end": {
      const block = findToolBlockById(state, event.id);
      if (block) {
        block.status = event.result.isError ? "err" : "ok";
        block.resultPreview = truncateOneline(
          event.result.content,
          TOOL_RESULT_PREVIEW_LIMIT,
        );
        block.endedAt = Date.now();
      }
      return state;
    }

    case "turn_end": {
      if (event.usage) {
        state.usage = mergeUsage(state.usage, event.usage);
      }
      return state;
    }

    case "mode_changed":
      state.mode = event.mode as PermissionMode;
      return state;

    case "todos_updated":
      // Todos render is deferred (would need a todos block kind). v1 ignores.
      return state;

    case "context_recovered":
      // Internal recovery — silent.
      return state;

    case "agent_end":
      closeStreamingBlocks(state);
      if (state.status === "running") {
        state.status = "completed";
      }
      return state;

    default:
      return state;
  }
}

/** Mark `status="interrupted"` and close any streaming blocks. */
export function markInterrupted(state: RunState): RunState {
  closeStreamingBlocks(state);
  state.status = "interrupted";
  state.updatedAt = Date.now();
  return state;
}

/** Mark `status="error"`. */
export function markError(state: RunState, error: Error | string): RunState {
  closeStreamingBlocks(state);
  state.status = "error";
  const message = typeof error === "string" ? error : (error.message || String(error));
  state.error = { message };
  state.updatedAt = Date.now();
  return state;
}

/** Mark `status="idle_timeout"`. */
export function markIdleTimeout(state: RunState): RunState {
  closeStreamingBlocks(state);
  if (state.status === "running") {
    state.status = "idle_timeout";
  }
  state.updatedAt = Date.now();
  return state;
}

/**
 * Last-block-only check used by idle watchdog: if there's an in-flight tool,
 * we don't count toward idle.
 */
export function hasInFlightTool(state: RunState): boolean {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i]!;
    if (block.kind === "tool" && block.status === "running") return true;
  }
  return false;
}

function closeStreamingBlocks(state: RunState): void {
  for (const block of state.blocks) {
    if (block.kind === "text" || block.kind === "thinking") {
      block.streaming = false;
    }
  }
}

function findToolBlockById(state: RunState, id: string): ToolBlock | undefined {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i]!;
    if (block.kind === "tool" && block.id === id) return block;
  }
  return undefined;
}

function appendBounded(prev: string, delta: string, max: number): string {
  if (prev.length + delta.length <= max) return prev + delta;
  const next = prev + delta;
  // Drop oldest characters; keep tail. Mark truncation only once.
  const overflow = next.length - max;
  return "…" + next.slice(overflow + 1);
}

function formatArgsPreview(args: Record<string, unknown>): string {
  // Pretty-print scalar fields inline; nested objects get JSON-stringified
  // briefly. This is the user-facing one-liner under the tool name.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    let formatted: string;
    if (typeof value === "string") {
      formatted = value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`;
    } else if (typeof value === "number" || typeof value === "boolean") {
      formatted = String(value);
    } else if (value === null) {
      formatted = "null";
    } else {
      try {
        const json = JSON.stringify(value);
        formatted = json.length > 60 ? `${json.slice(0, 57)}...` : json;
      } catch {
        formatted = "[unserializable]";
      }
    }
    parts.push(`${key}=${formatted}`);
    if (parts.join(", ").length > TOOL_ARGS_PREVIEW_LIMIT) {
      parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, TOOL_ARGS_PREVIEW_LIMIT - parts.slice(0, -1).join(", ").length) + "…";
      break;
    }
  }
  return parts.join(", ");
}

function truncateOneline(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

function mergeUsage(prev: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!prev) return { ...next };
  return {
    promptTokens: prev.promptTokens + (next.promptTokens ?? 0),
    completionTokens: prev.completionTokens + (next.completionTokens ?? 0),
    promptCacheHitTokens: (prev.promptCacheHitTokens ?? 0) + (next.promptCacheHitTokens ?? 0),
    promptCacheMissTokens: (prev.promptCacheMissTokens ?? 0) + (next.promptCacheMissTokens ?? 0),
    cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0),
    reasoningTokens: (prev.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    totalTokens: (prev.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}
