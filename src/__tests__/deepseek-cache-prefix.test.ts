import { describe, expect, it } from "vitest";
import { toChatCompletionsMessage } from "../provider.js";
import { resolveProviderRequestConfig } from "../provider-transform.js";
import type { ProviderMessage } from "../types.js";

// DeepSeek's disk-based prompt cache only hits when a previously persisted
// prefix unit is fully matched byte-for-byte. For a multi-turn coding agent
// this means: every request after the first must produce the *same* serialized
// prefix as the prior request, plus the new assistant/user/tool messages
// appended at the end. If we mutate history, reorder fields, or serialize the
// same logical message in two different ways across turns, the cache misses.
//
// These tests exercise that invariant directly against `toChatCompletionsMessage`
// with the DeepSeek `reasoningContentEcho: "all"` setting that `provider-transform`
// applies for deepseek-v4-flash / deepseek-v4-pro.

const DEEPSEEK_ECHO = { reasoningContentEcho: "all" as const };

function serializePrefix(messages: ProviderMessage[]): string {
  return JSON.stringify(
    messages.map((m) => toChatCompletionsMessage(m, DEEPSEEK_ECHO)),
  );
}

describe("DeepSeek prompt-cache prefix stability", () => {
  it("provider-transform wires DeepSeek v4 to reasoningContentEcho=all", () => {
    const flash = resolveProviderRequestConfig("deepseek", "deepseek-v4-flash", "high");
    const pro = resolveProviderRequestConfig("deepseek", "deepseek-v4-pro", "max");
    expect(flash.reasoningContentEcho).toBe("all");
    expect(pro.reasoningContentEcho).toBe("all");
  });

  it("appending an assistant + user turn keeps the prior prefix byte-identical", () => {
    const turn1: ProviderMessage[] = [
      { role: "system", content: "You are a helpful coding agent." },
      { role: "user", content: "What does src/foo.ts do?" },
    ];

    const assistantReply: ProviderMessage = {
      role: "assistant",
      content: "It defines a parser.",
      reasoning: "User asked about foo.ts; I will summarize.",
    };

    const turn2: ProviderMessage[] = [
      ...turn1,
      assistantReply,
      { role: "user", content: "How is it used?" },
    ];

    const turn1Bytes = serializePrefix(turn1);
    const turn2PrefixBytes = serializePrefix(turn2.slice(0, turn1.length));

    expect(turn2PrefixBytes).toBe(turn1Bytes);
  });

  it("tool-call round trip preserves prefix bytes across the next turn", () => {
    const turn1: ProviderMessage[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read src/index.ts" },
    ];

    const assistantToolCall: ProviderMessage = {
      role: "assistant",
      content: "",
      reasoning: "Need to read the file before answering.",
      toolCalls: [
        { id: "call_1", name: "read", arguments: '{"path":"src/index.ts"}' },
      ],
    };
    const toolResult: ProviderMessage = {
      role: "tool",
      toolCallId: "call_1",
      content: "export const x = 1;",
    };
    const assistantSummary: ProviderMessage = {
      role: "assistant",
      content: "It exports x = 1.",
      reasoning: "",
    };

    // What turn 2's request body looks like as the agent appends to history.
    const turn2: ProviderMessage[] = [
      ...turn1,
      assistantToolCall,
      toolResult,
      assistantSummary,
      { role: "user", content: "Anything else exported?" },
    ];

    // Replay each intermediate snapshot. Every prior prefix must remain
    // byte-identical to its first appearance.
    const snapshots: ProviderMessage[][] = [
      turn1,
      [...turn1, assistantToolCall],
      [...turn1, assistantToolCall, toolResult],
      [...turn1, assistantToolCall, toolResult, assistantSummary],
      turn2,
    ];

    for (let i = 1; i < snapshots.length; i += 1) {
      const earlier = serializePrefix(snapshots[i - 1]);
      const laterPrefix = serializePrefix(snapshots[i].slice(0, snapshots[i - 1].length));
      expect(laterPrefix).toBe(earlier);
    }
  });

  it("normalizes missing reasoning to '' so undefined vs '' do not break the prefix", () => {
    // Critical for DeepSeek: if a turn's history reconstructs an assistant
    // message without an explicit `reasoning` field, the echo must still emit
    // the same `reasoning_content: ""` that was sent originally. Otherwise the
    // historical message bytes diverge after a session reload.
    const withUndefined: ProviderMessage = { role: "assistant", content: "ok" };
    const withEmpty: ProviderMessage = { role: "assistant", content: "ok", reasoning: "" };

    expect(JSON.stringify(toChatCompletionsMessage(withUndefined, DEEPSEEK_ECHO)))
      .toBe(JSON.stringify(toChatCompletionsMessage(withEmpty, DEEPSEEK_ECHO)));
  });

  it("emits stable key order across repeated serializations of the same message", () => {
    // JSON.stringify follows insertion order; this guards against accidentally
    // introducing a spread/merge that would shuffle keys between turns.
    const msg: ProviderMessage = {
      role: "assistant",
      content: "",
      reasoning: "thinking",
      toolCalls: [
        { id: "call_a", name: "grep", arguments: '{"q":"foo"}' },
      ],
    };
    const a = JSON.stringify(toChatCompletionsMessage(msg, DEEPSEEK_ECHO));
    const b = JSON.stringify(toChatCompletionsMessage(msg, DEEPSEEK_ECHO));
    expect(a).toBe(b);
    // Sanity check on the canonical shape we depend on.
    expect(a).toBe(
      '{"role":"assistant","content":null,"reasoning_content":"thinking","tool_calls":[{"id":"call_a","type":"function","function":{"name":"grep","arguments":"{\\"q\\":\\"foo\\"}"}}]}',
    );
  });

  it("identical tool_calls arguments string yields identical bytes (no re-encoding drift)", () => {
    // The agent stores `arguments` as the raw JSON string from the stream.
    // Re-parsing+restringifying could reorder keys and break the cache prefix.
    const original = '{"path":"a.ts","limit":100}';
    const msg: ProviderMessage = {
      role: "assistant",
      content: "",
      reasoning: "",
      toolCalls: [{ id: "c1", name: "read", arguments: original }],
    };
    const out = toChatCompletionsMessage(msg, DEEPSEEK_ECHO) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    expect(out.tool_calls[0].function.arguments).toBe(original);
  });
});
