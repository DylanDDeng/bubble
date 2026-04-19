import { describe, expect, it } from "vitest";
import { projectMessages, repairToolCallChains } from "../context/projector.js";
import type { Message } from "../types.js";

describe("repairToolCallChains", () => {
  it("leaves a well-formed conversation untouched", () => {
    const input: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "edit:1", name: "edit", arguments: "{}" },
          { id: "edit:2", name: "edit", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "edit:1", content: "ok" },
      { role: "tool", toolCallId: "edit:2", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    expect(repairToolCallChains(input)).toEqual(input);
  });

  it("synthesizes a placeholder when a tool_call has no response", () => {
    const input: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "edit:1", name: "edit", arguments: "{}" },
          { id: "edit:6", name: "edit", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "edit:1", content: "ok" },
      { role: "user", content: "next" },
    ];

    const out = repairToolCallChains(input);
    const synthetic = out[3];
    expect(synthetic).toEqual({
      role: "tool",
      toolCallId: "edit:6",
      content: "[no result captured for tool call edit (edit:6)]",
    });
    expect(out[4]).toEqual({ role: "user", content: "next" });
  });

  it("pulls a tool message back into place when a foreign message interleaved between tool_calls and tool", () => {
    // Simulates Shift+Tab firing mid-stream — setMode injects a meta-user
    // reminder between the assistant's tool_calls and its tool result.
    const input: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:6", name: "edit", arguments: "{}" }],
      },
      { role: "user", content: "<system-reminder>", isMeta: true },
      { role: "tool", toolCallId: "edit:6", content: "ok" },
    ];

    const out = repairToolCallChains(input);
    expect(out).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:6", name: "edit", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "edit:6", content: "ok" },
      { role: "user", content: "<system-reminder>", isMeta: true },
    ]);
  });

  it("drops orphan tool messages with no preceding tool_call", () => {
    const input: Message[] = [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "ghost:1", content: "leftover" },
      { role: "assistant", content: "hi" },
    ];
    expect(repairToolCallChains(input)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("drops orphan tool messages that don't match any pending id even if they appear inside a tool window", () => {
    const input: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:1", name: "edit", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "stale:9", content: "from a previous turn" },
      { role: "tool", toolCallId: "edit:1", content: "ok" },
    ];
    const out = repairToolCallChains(input);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:1", name: "edit", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "edit:1", content: "ok" },
    ]);
  });

  it("preserves tool message order matching the assistant's toolCalls order", () => {
    const input: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "edit", arguments: "{}" },
          { id: "b", name: "edit", arguments: "{}" },
          { id: "c", name: "edit", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "c", content: "C" },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
    ];
    const out = repairToolCallChains(input);
    expect(out.slice(1).map((m: any) => m.toolCallId)).toEqual(["a", "b", "c"]);
  });
});

describe("projectMessages", () => {
  it("repairs the chain before returning, even in default (full) mode", () => {
    const input: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:6", name: "edit", arguments: "{}" }],
      },
      { role: "user", content: "next" },
    ];

    const out = projectMessages(input);
    const synth = out.find((m) => m.role === "tool") as any;
    expect(synth).toBeDefined();
    expect(synth.toolCallId).toBe("edit:6");
  });
});
