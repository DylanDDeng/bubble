import { describe, expect, it } from "vitest";
import { pruneMessages } from "../context/prune.js";
import type { Message } from "../types.js";

function longText(label: string): string {
  return `${label}: ` + "x".repeat(300);
}

describe("pruneMessages", () => {
  it("replaces older low-value tool output with a compact placeholder", () => {
    const messages: Message[] = [
      { role: "user", content: "read files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", arguments: "{\"file\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_1", content: longText("file a") },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_2", name: "read", arguments: "{\"file\":\"b.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_2", content: longText("file b") },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_3", name: "read", arguments: "{\"file\":\"c.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_3", content: longText("file c") },
    ];

    const pruned = pruneMessages(messages);
    expect((pruned[2] as any).content).toContain("output omitted to control context size");
    expect((pruned[4] as any).content).toBe(messages[4].content);
    expect((pruned[6] as any).content).toBe(messages[6].content);
  });

  it("preserves high-value or error tool outputs", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "write", arguments: "{\"file\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_1", content: longText("write result") },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_2", name: "bash", arguments: "{\"command\":\"bad\"}" }],
      },
      { role: "tool", toolCallId: "call_2", content: "Error: command failed" },
    ];

    const pruned = pruneMessages(messages);
    expect((pruned[1] as any).content).toBe(messages[1].content);
    expect((pruned[3] as any).content).toBe(messages[3].content);
  });
});
