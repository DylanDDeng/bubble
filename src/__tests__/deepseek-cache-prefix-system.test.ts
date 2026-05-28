import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../prompt/compose.js";
import { createAllTools } from "../tools/index.js";
import { toChatCompletionsMessage } from "../provider.js";
import { projectMessages } from "../context/projector.js";
import type { Message, ProviderMessage, ToolDefinition } from "../types.js";

// Companion to deepseek-cache-prefix.test.ts.
//
// The message-serialization tests in the sibling file cover the historical
// part of a DeepSeek request body. This file covers the *front* of the body:
// system prompt + tools array. Both blocks sit before any user message, so
// any non-determinism here forces a full cache miss on every turn.
//
// We assert two things:
//   1. Given identical inputs, `composeSystemPrompt` and `createAllTools`
//      produce byte-identical output across calls.
//   2. The combined request-body prefix (system + tools + history) is
//      byte-identical across two simulated turns when only the new tail
//      messages differ — i.e. exactly what DeepSeek's prefix-match cache
//      requires.

const DEEPSEEK_ECHO = { reasoningContentEcho: "all" as const };

const STABLE_PROMPT_OPTIONS = {
  agentName: "Bubble",
  configuredProvider: "deepseek",
  configuredModel: "deepseek-v4-flash",
  configuredModelId: "deepseek-v4-flash",
  workingDir: "/repo",
  currentDate: "2026-05-20", // pinned: do not rely on wall clock
  tools: ["read", "bash", "edit"],
  thinkingLevel: "high" as const,
};

function toOpenAiTools(tools: ToolDefinition[]): unknown {
  // Mirrors `provider.ts:115-122` exactly — the cache cares about this shape.
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function serializeRequestPrefix(
  systemPrompt: string,
  tools: ToolDefinition[],
  history: ProviderMessage[],
): string {
  return JSON.stringify({
    // DeepSeek goes through the Chat Completions path: system is a message,
    // not a top-level `instructions` field.
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((m) => toChatCompletionsMessage(m, DEEPSEEK_ECHO)),
    ],
    tools: toOpenAiTools(tools),
    tool_choice: "auto",
  });
}

function serializeProjectedRequest(
  tools: ToolDefinition[],
  messages: ProviderMessage[],
): string {
  return JSON.stringify({
    messages: messages.map((m) => toChatCompletionsMessage(m, DEEPSEEK_ECHO)),
    tools: toOpenAiTools(tools),
    tool_choice: "auto",
  });
}

describe("DeepSeek cache prefix — system prompt + tools", () => {
  it("composeSystemPrompt is byte-deterministic when all dynamic inputs are pinned", () => {
    const a = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    const b = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("DeepSeek provider prompt path produces the same bytes on repeated calls", () => {
    // Specifically exercise the provider === "deepseek" branch in compose.ts.
    const opts = { ...STABLE_PROMPT_OPTIONS, configuredProvider: "deepseek" };
    expect(composeSystemPrompt(opts)).toBe(composeSystemPrompt(opts));
  });

  it("currentDate is the only wall-clock input — pinning it removes time dependence", () => {
    // If `currentDate` is left to default it embeds today's UTC date into the
    // prompt, which means a session that crosses UTC midnight will get a
    // different prefix and miss the cache for the rest of the day.
    const pinnedYesterday = composeSystemPrompt({ ...STABLE_PROMPT_OPTIONS, currentDate: "2026-05-19" });
    const pinnedToday = composeSystemPrompt({ ...STABLE_PROMPT_OPTIONS, currentDate: "2026-05-20" });
    expect(pinnedYesterday).not.toBe(pinnedToday);
    expect(pinnedToday).toContain("2026-05-20");

    // And when no override is passed, the default value is today's UTC date.
    const expectedToday = new Date().toISOString().slice(0, 10);
    const dynamic = composeSystemPrompt({ ...STABLE_PROMPT_OPTIONS, currentDate: undefined });
    expect(dynamic).toContain(expectedToday);
  });

  it("createAllTools returns the same tool order and identical JSON across calls", () => {
    const tools1 = createAllTools("/repo");
    const tools2 = createAllTools("/repo");

    expect(tools1.map((t) => t.name)).toEqual(tools2.map((t) => t.name));

    const json1 = JSON.stringify(toOpenAiTools(tools1));
    const json2 = JSON.stringify(toOpenAiTools(tools2));
    expect(json1).toBe(json2);
  });

  it("tool parameters JSON is key-order stable across calls (no schema reshuffling)", () => {
    // Spot-check the `read` tool's schema: the cache cares about exact bytes,
    // and parameters are plain object literals — they should serialize the
    // same way every time.
    const read1 = createAllTools("/repo").find((t) => t.name === "read");
    const read2 = createAllTools("/repo").find((t) => t.name === "read");
    expect(read1).toBeDefined();
    expect(read2).toBeDefined();
    expect(JSON.stringify(read1!.parameters)).toBe(JSON.stringify(read2!.parameters));
  });

  it("full request prefix is byte-identical across two consecutive turns", () => {
    // This is the integrated property that actually determines cache hits:
    // turn N's full serialized body, minus the trailing new messages, must
    // equal turn N+1's serialized prefix.
    const systemPrompt = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    const tools = createAllTools("/repo");

    const turn1History: ProviderMessage[] = [
      { role: "user", content: "Find references to FooBar" },
    ];

    const turn2History: ProviderMessage[] = [
      ...turn1History,
      {
        role: "assistant",
        content: "",
        reasoning: "I will grep the repo.",
        toolCalls: [
          { id: "call_1", name: "grep", arguments: '{"pattern":"FooBar"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "src/a.ts:1: FooBar" },
      { role: "assistant", content: "Found one match in src/a.ts.", reasoning: "" },
      { role: "user", content: "Open it and explain" },
    ];

    const turn1Body = serializeRequestPrefix(systemPrompt, tools, turn1History);
    const turn2PrefixBody = serializeRequestPrefix(
      systemPrompt,
      tools,
      turn2History.slice(0, turn1History.length),
    );

    expect(turn2PrefixBody).toBe(turn1Body);
  });

  it("recomposing the system prompt between turns does not perturb the bytes", () => {
    // Real sessions re-call `composeSystemPrompt` on each turn (e.g. when
    // tools or skills change). With pinned inputs the result must be stable,
    // otherwise the whole cached prefix is lost even though nothing
    // meaningful changed.
    const turn1Prompt = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    const turn2Prompt = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    const tools = createAllTools("/repo");
    const history: ProviderMessage[] = [
      { role: "user", content: "list files" },
    ];

    expect(serializeRequestPrefix(turn2Prompt, tools, history))
      .toBe(serializeRequestPrefix(turn1Prompt, tools, history));
  });

  it("new runtime reminders append near the active turn instead of rewriting the cached prefix", () => {
    const tools = createAllTools("/repo");
    const systemPrompt = composeSystemPrompt(STABLE_PROMPT_OPTIONS);
    const turn1Messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Find references to FooBar" },
      { role: "meta", kind: "system-reminder", content: "Debugging workflow: find the failing boundary." },
    ];
    const turn1Projected = projectMessages(turn1Messages);
    const turn1Body = serializeProjectedRequest(tools, turn1Projected);

    const turn2Messages: Message[] = [
      ...turn1Messages,
      { role: "assistant", content: "Found one reference." },
      { role: "user", content: "Open it and explain" },
      { role: "meta", kind: "system-reminder", content: "Code explanation workflow: answer directly." },
    ];
    const turn2Projected = projectMessages(turn2Messages);
    const turn2PrefixBody = serializeProjectedRequest(
      tools,
      turn2Projected.slice(0, turn1Projected.length),
    );

    expect(turn2PrefixBody).toBe(turn1Body);
    expect(turn2Projected[0]).toEqual({ role: "system", content: systemPrompt });
    expect(turn2Projected.at(-1)).toEqual({
      role: "user",
      content: "Runtime reminder:\nCode explanation workflow: answer directly.",
    });
  });
});
