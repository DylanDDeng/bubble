import { describe, expect, it } from "vitest";
import { aggressivePruneMessages, pruneMessages } from "../context/prune.js";
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

describe("aggressivePruneMessages", () => {
  it("drops older prunable tool output but preserves the latest unresolved tool turn", () => {
    const messages: Message[] = [
      { role: "user", content: "do a lot of reads" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "old_1", name: "read", arguments: "{\"file\":\"old-a.ts\"}" },
          { id: "old_2", name: "grep", arguments: "{\"pattern\":\"legacy\"}" },
        ],
      },
      { role: "tool", toolCallId: "old_1", content: longText("old a") },
      { role: "tool", toolCallId: "old_2", content: longText("old hits") },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "read", arguments: "{\"file\":\"a.ts\"}" },
          { id: "c2", name: "read", arguments: "{\"file\":\"b.ts\"}" },
          { id: "c3", name: "grep", arguments: "{\"pattern\":\"foo\"}" },
        ],
      },
      { role: "tool", toolCallId: "c1", content: longText("a") },
      { role: "tool", toolCallId: "c2", content: longText("b") },
      { role: "tool", toolCallId: "c3", content: longText("hits") },
    ];

    const pruned = aggressivePruneMessages(messages);
    expect((pruned[2] as any).content).toContain("output omitted");
    expect((pruned[3] as any).content).toContain("output omitted");
    expect((pruned[5] as any).content).toBe(messages[5].content);
    expect((pruned[6] as any).content).toBe(messages[6].content);
    expect((pruned[7] as any).content).toBe(messages[7].content);
  });

  it("still skips short outputs and errors", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "read", arguments: "{\"file\":\"a.ts\"}" },
          { id: "c2", name: "bash", arguments: "{\"command\":\"ls\"}" },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "short" },
      { role: "tool", toolCallId: "c2", content: "Error: failed" },
    ];

    const pruned = aggressivePruneMessages(messages);
    expect((pruned[1] as any).content).toBe("short");
    expect((pruned[2] as any).content).toBe("Error: failed");
  });

  it("preserves the active tool turn even when meta reminders follow it", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", arguments: "{\"file\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_1", content: longText("active read") },
      { role: "user", content: "<system-reminder>mode changed</system-reminder>", isMeta: true },
    ];

    const pruned = aggressivePruneMessages(messages);
    expect((pruned[1] as any).content).toBe(messages[1].content);
  });
});
