/**
 * Structured output for print mode (`-p --output-format json`).
 *
 * Built for benchmark/CI adapters (Pier, terminal-bench): stdout carries
 * exactly one JSON object; all human-facing noise goes to stderr. Field
 * names follow the grok-build/Claude Code convention (text, stopReason,
 * sessionId, usage.{input_tokens,...}, num_turns) so existing harness
 * adapters port with minimal changes.
 */

import type { AgentEvent, TokenUsage } from "./types.js";

export type PrintOutputFormat = "plain" | "json";

export function parseOutputFormat(raw: string | undefined): PrintOutputFormat | undefined {
  if (raw === undefined) return undefined;
  if (raw === "plain" || raw === "json") return raw;
  return undefined;
}

export interface PrintUsageSummary {
  input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

export interface PrintRunSummary {
  /** Final answer: the last turn's streamed text. */
  text: string;
  num_turns: number;
  num_tool_calls: number;
  usage: PrintUsageSummary;
  /**
   * False when no turn carried provider usage (some endpoints — notably the
   * Grok subscription proxy — omit it): zeros then mean "not reported",
   * not "free". Mirrors the goal engine's markTokenUsageUnavailable and
   * grok-build's usage_is_incomplete convention.
   */
  usage_reported: boolean;
}

export class PrintRunCollector {
  private turnText = "";
  private lastTurnText = "";
  private turns = 0;
  private toolCalls = 0;
  private usageReported = false;
  private readonly usage: PrintUsageSummary = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  };

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        this.turnText = "";
        break;
      case "text_delta":
        this.turnText += event.content;
        break;
      case "provider_retry":
        // The retried response supersedes the partial text.
        this.turnText = "";
        break;
      case "tool_start":
        this.toolCalls += 1;
        break;
      case "turn_end":
        // Usage reaches AgentEvent only on turn_end (the stream-level
        // "usage" chunk is aggregated into it by the agent loop).
        if (this.turnText.trim()) this.lastTurnText = this.turnText;
        if (event.usage) this.addUsage(event.usage);
        break;
      default:
        break;
    }
  }

  private addUsage(usage: TokenUsage): void {
    this.usageReported = true;
    this.usage.input_tokens += usage.promptTokens ?? 0;
    this.usage.cache_read_input_tokens += usage.promptCacheHitTokens ?? 0;
    this.usage.output_tokens += usage.completionTokens ?? 0;
    this.usage.reasoning_tokens += usage.reasoningTokens ?? 0;
    this.usage.total_tokens += usage.totalTokens
      ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
  }

  summary(): PrintRunSummary {
    return {
      text: (this.lastTurnText || this.turnText).trim(),
      num_turns: this.turns,
      num_tool_calls: this.toolCalls,
      usage: { ...this.usage },
      usage_reported: this.usageReported,
    };
  }
}

export function formatPrintJson(input: {
  summary: PrintRunSummary;
  sessionId?: string;
  stopReason?: "end_turn" | "error" | "cancelled";
}): string {
  return JSON.stringify({
    text: input.summary.text,
    stopReason: input.stopReason ?? "end_turn",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    num_turns: input.summary.num_turns,
    num_tool_calls: input.summary.num_tool_calls,
    usage: input.summary.usage,
    usage_reported: input.summary.usage_reported,
  });
}

export function formatPrintJsonError(input: {
  message: string;
  summary?: PrintRunSummary;
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: "error",
    message: input.message,
    stopReason: "error",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.summary
      ? {
          text: input.summary.text,
          num_turns: input.summary.num_turns,
          num_tool_calls: input.summary.num_tool_calls,
          usage: input.summary.usage,
        }
      : {}),
  });
}
