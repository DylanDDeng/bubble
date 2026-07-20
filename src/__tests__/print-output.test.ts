import { describe, expect, it } from "vitest";
import {
  PrintRunCollector,
  formatPrintJson,
  formatPrintJsonError,
  parseOutputFormat,
} from "../print-output.js";
import type { AgentEvent } from "../types.js";

function feed(events: AgentEvent[]): PrintRunCollector {
  const collector = new PrintRunCollector();
  for (const event of events) collector.onEvent(event);
  return collector;
}

describe("PrintRunCollector", () => {
  it("keeps the final turn's text as the answer across an agentic run", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "text_delta", content: "let me look..." },
      { type: "tool_start", id: "1", name: "read", args: {} },
      { type: "turn_end", willContinue: true },
      { type: "turn_start" },
      { type: "text_delta", content: "The answer " },
      { type: "text_delta", content: "is 42." },
      { type: "turn_end" },
    ] as AgentEvent[]);

    const summary = collector.summary();
    expect(summary.text).toBe("The answer is 42.");
    expect(summary.num_turns).toBe(2);
    expect(summary.num_tool_calls).toBe(1);
  });

  it("keeps the last non-empty turn text when the final turn is tool-only", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "text_delta", content: "Done: all tests pass." },
      { type: "turn_end", willContinue: true },
      { type: "turn_start" },
      { type: "tool_start", id: "1", name: "bash", args: {} },
      { type: "turn_end" },
    ] as AgentEvent[]);

    expect(collector.summary().text).toBe("Done: all tests pass.");
  });

  it("accumulates usage across turn_end events", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "turn_end", willContinue: true, usage: { promptTokens: 100, completionTokens: 20, promptCacheHitTokens: 60, reasoningTokens: 5, totalTokens: 120 } },
      { type: "turn_start" },
      { type: "turn_end", usage: { promptTokens: 200, completionTokens: 30 } },
    ] as AgentEvent[]);

    const usage = collector.summary().usage;
    expect(usage.input_tokens).toBe(300);
    expect(usage.cache_read_input_tokens).toBe(60);
    expect(usage.output_tokens).toBe(50);
    expect(usage.reasoning_tokens).toBe(5);
    // totalTokens present (120) + fallback prompt+completion (230).
    expect(usage.total_tokens).toBe(350);
  });

  it("discards partial text superseded by a provider retry", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "text_delta", content: "half an ans" },
      { type: "provider_retry", attempt: 1, maxAttempts: 3 },
      { type: "text_delta", content: "The full answer." },
      { type: "turn_end" },
    ] as AgentEvent[]);

    expect(collector.summary().text).toBe("The full answer.");
  });
});

describe("formatPrintJson", () => {
  it("emits a single parseable object with the documented fields", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "text_delta", content: "hi" },
      { type: "turn_end", usage: { promptTokens: 10, completionTokens: 2 } },
    ] as AgentEvent[]);

    const parsed = JSON.parse(formatPrintJson({
      summary: collector.summary(),
      sessionId: "2026-07-19T00-00-00-000Z.jsonl",
    }));

    expect(parsed).toMatchObject({
      text: "hi",
      stopReason: "end_turn",
      sessionId: "2026-07-19T00-00-00-000Z.jsonl",
      num_turns: 1,
      num_tool_calls: 0,
    });
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.usage.output_tokens).toBe(2);
    expect(parsed.usage_reported).toBe(true);
  });

  it("marks usage_reported false when the provider never sent usage", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "text_delta", content: "hi" },
      { type: "turn_end" },
    ] as AgentEvent[]);

    const parsed = JSON.parse(formatPrintJson({ summary: collector.summary() }));
    expect(parsed.usage_reported).toBe(false);
    expect(parsed.usage.total_tokens).toBe(0);
  });

  it("formats structured errors with partial progress", () => {
    const collector = feed([
      { type: "turn_start" },
      { type: "tool_start", id: "1", name: "bash", args: {} },
    ] as AgentEvent[]);

    const parsed = JSON.parse(formatPrintJsonError({
      message: "provider quota exceeded",
      summary: collector.summary(),
    }));

    expect(parsed.type).toBe("error");
    expect(parsed.stopReason).toBe("error");
    expect(parsed.message).toContain("quota");
    expect(parsed.num_tool_calls).toBe(1);
  });
});

describe("parseOutputFormat", () => {
  it("accepts plain and json, rejects everything else", () => {
    expect(parseOutputFormat("plain")).toBe("plain");
    expect(parseOutputFormat("json")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBeUndefined();
    expect(parseOutputFormat(undefined)).toBeUndefined();
  });
});
