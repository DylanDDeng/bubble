import { describe, expect, it } from "vitest";
import { aggressivePruneMessages, markStableCurrentToolResultsForCache, pruneMessages } from "../context/prune.js";
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

  it("keeps a full tool result stable after it has been sent in the active frontier", () => {
    const messages: Message[] = [
      { role: "user", content: "read files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", arguments: "{\"file\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_1", content: longText("file a") },
    ];

    markStableCurrentToolResultsForCache(messages);
    messages.push(
      { role: "assistant", content: "read a" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_2", name: "read", arguments: "{\"file\":\"b.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_2", content: longText("file b") },
      { role: "assistant", content: "read b" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_3", name: "read", arguments: "{\"file\":\"c.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_3", content: longText("file c") },
      { role: "assistant", content: "read c" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_4", name: "read", arguments: "{\"file\":\"d.ts\"}" }],
      },
      { role: "tool", toolCallId: "call_4", content: longText("file d") },
    );

    const pruned = pruneMessages(messages);
    expect((pruned[2] as any).content).toBe(messages[2].content);
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
      { role: "meta", kind: "system-reminder", content: "mode changed" },
    ];

    const pruned = aggressivePruneMessages(messages);
    expect((pruned[1] as any).content).toBe(messages[1].content);
  });
});

describe("cache-stability marking across a steered turn", () => {
  function turn(index: number): Message[] {
    return [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call_${index}`, name: "read", arguments: "{}" }],
      },
      { role: "tool", toolCallId: `call_${index}`, content: longText(`file ${index}`) },
    ];
  }

  it("still marks the finished batch when the user steers mid-run", () => {
    // applyPendingInputs appends the steered user message before the marking
    // pass runs. Stopping the backward walk on that user message left the batch
    // unmarked forever: it became a live prune candidate, so a later batch
    // rewrote its content mid-history — losing tool output the model may still
    // need, and invalidating the provider prefix cache from that point on.
    const messages: Message[] = [
      { role: "user", content: "read files" },
      ...turn(1),
      { role: "user", content: "also check the parser" },
    ];

    markStableCurrentToolResultsForCache(messages);

    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata).toMatchObject({ cacheStableProjection: "full" });
  });

  it("keeps a steered-over batch verbatim through later pruning", () => {
    const messages: Message[] = [
      { role: "user", content: "read files" },
      ...turn(1),
      { role: "user", content: "also check the parser" },
    ];
    markStableCurrentToolResultsForCache(messages);

    // Two more batches arrive; without the mark, batch 1 would be the oldest
    // candidate and get replaced by a placeholder.
    messages.push(...turn(2), ...turn(3), ...turn(4));
    const pruned = pruneMessages(messages);

    const first = pruned.find(
      (message): message is Extract<Message, { role: "tool" }> =>
        message.role === "tool" && message.toolCallId === "call_1",
    );
    expect(first?.content).toBe(longText("file 1"));
  });

  it("does not stop the walk at an assistant turn that made no tool calls", () => {
    const messages: Message[] = [
      { role: "user", content: "read files" },
      ...turn(1),
      { role: "user", content: "thanks" },
      { role: "assistant", content: "you're welcome" },
      { role: "user", content: "one more thing" },
    ];

    markStableCurrentToolResultsForCache(messages);

    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata?.cacheStableProjection).toBeUndefined();
  });
});
