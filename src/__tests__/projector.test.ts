import { describe, expect, it } from "vitest";
import { projectMessages, repairToolCallChains } from "../context/projector.js";
import type { Message, ProviderMessage } from "../types.js";

describe("repairToolCallChains", () => {
  it("leaves a well-formed conversation untouched", () => {
    const input: ProviderMessage[] = [
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
    const input: ProviderMessage[] = [
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
    const input: ProviderMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "edit:6", name: "edit", arguments: "{}" }],
      },
      { role: "system", content: "runtime reminder" },
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
      { role: "system", content: "runtime reminder" },
    ]);
  });

  it("drops orphan tool messages with no preceding tool_call", () => {
    const input: ProviderMessage[] = [
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
    const input: ProviderMessage[] = [
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
    const input: ProviderMessage[] = [
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

  it("projects runtime meta into system context instead of user messages", () => {
    const out = projectMessages([
      { role: "system", content: "base" },
      { role: "user", content: "go" },
      { role: "meta", kind: "system-reminder", content: "Plan mode is now ACTIVE." },
    ]);

    expect(out).toEqual([
      { role: "system", content: "base\n\nRuntime reminder:\nPlan mode is now ACTIVE." },
      { role: "user", content: "go" },
    ]);
  });

  it("does not project meta excluded from model context", () => {
    const out = projectMessages([
      { role: "system", content: "base" },
      { role: "meta", kind: "runtime-context", content: "hidden", includeInLlm: false },
      { role: "user", content: "go" },
    ]);

    expect(out).toEqual([
      { role: "system", content: "base" },
      { role: "user", content: "go" },
    ]);
  });
});
