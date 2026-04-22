import { describe, expect, it } from "vitest";
import { compactDisplayMessages, type DisplayMessage } from "../tui/display-history.js";

describe("compactDisplayMessages", () => {
  it("caps retained UI messages and inserts a synthetic summary", () => {
    const messages: DisplayMessage[] = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(200)}`,
    }));

    const compacted = compactDisplayMessages(messages);
    expect(compacted.length).toBeLessThanOrEqual(81);
    expect(compacted[0].syntheticKind).toBe("ui_summary");
    expect(compacted[0].hiddenCount).toBe(20);
  });

  it("truncates older tool results but leaves the recent detail window intact", () => {
    const messages: DisplayMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant",
      content: `assistant ${index} ${"y".repeat(1800)}`,
      toolCalls: [{
        id: `tool-${index}`,
        name: "read",
        args: { path: `file-${index}.ts` },
        result: `result ${index}\n${"z".repeat(2400)}`,
      }],
    }));

    const compacted = compactDisplayMessages(messages);
    expect(compacted[0].content.length).toBeLessThan(messages[0].content.length);
    expect(compacted[0].toolCalls?.[0].result?.length).toBeLessThan(
      messages[0].toolCalls?.[0].result?.length ?? Infinity,
    );

    const recent = compacted.at(-1)!;
    expect(recent.content).toBe(messages.at(-1)!.content);
    expect(recent.toolCalls?.[0].result).toBe(messages.at(-1)!.toolCalls?.[0].result);
  });
});
