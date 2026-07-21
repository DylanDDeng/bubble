import { describe, expect, it, vi } from "vitest";
import { compactMessages, findFirstRealUserIndex, PINNED_INSTRUCTION_MAX_CHARS } from "../context/compact.js";
import { compactWithLLM, LLM_SUMMARY_PREFIX } from "../context/llm-compactor.js";
import type { Message, Provider } from "../types.js";

// A long instruction whose critical requirement sits far past the 140-char
// heuristic summary truncation point — the exact shape that used to lose
// "commit when you are done" on DeepSWE-style tasks.
const LATE_REQUIREMENT = "IMPORTANT_LATE_REQUIREMENT_MARKER: archive the results before finishing.";
const LONG_INSTRUCTION = `Implement the widget serialization feature. ${"Detail sentence. ".repeat(30)}${LATE_REQUIREMENT}`;

const INTERNAL_BLOCK_USER = '<bubble_internal_reminder kind="mode">\nplan mode is active\n</bubble_internal_reminder>';

function assistant(content: string): Message {
  return { role: "assistant", content };
}

function user(content: string): Message {
  return { role: "user", content };
}

function multiTurnHistory(first: Message): Message[] {
  return [
    { role: "system", content: "sys prompt" },
    first,
    assistant("worked on step one"),
    user("looks good, continue with part two"),
    assistant("did part two"),
    user("now part three"),
    assistant("did part three"),
    user("and part four"),
    assistant("did part four"),
  ];
}

describe("findFirstRealUserIndex", () => {
  it("skips internal reminder blocks re-rolled into user role", () => {
    const messages: Message[] = [
      user(INTERNAL_BLOCK_USER),
      user("the actual ask"),
    ];
    expect(findFirstRealUserIndex(messages)).toBe(1);
  });

  it("returns -1 when the first real user message exceeds the pin size cap", () => {
    const messages: Message[] = [
      user("x".repeat(PINNED_INSTRUCTION_MAX_CHARS + 1)),
      user("small follow-up"),
    ];
    expect(findFirstRealUserIndex(messages)).toBe(-1);
  });

  it("returns -1 when there is no user message", () => {
    expect(findFirstRealUserIndex([assistant("hello")])).toBe(-1);
  });
});

describe("compactMessages pinning", () => {
  it("keeps the original instruction verbatim above the summary", () => {
    const result = compactMessages(multiTurnHistory(user(LONG_INSTRUCTION)), { keepRecentTurns: 2 });

    expect(result.compacted).toBe(true);
    const out = result.messages!;
    expect(out[0]).toMatchObject({ role: "system", content: "sys prompt" });
    // Pinned instruction sits between the preserved prefix and the summary.
    expect(out[1]).toMatchObject({ role: "user", content: LONG_INSTRUCTION });
    expect(out[2].role).toBe("system");
    expect(out[2].content).toContain("Previous conversation summary:");
    // The late requirement survives in full, not truncated into the summary.
    expect(out[1].content).toContain(LATE_REQUIREMENT);
    expect(result.summary).not.toContain("IMPORTANT_LATE_REQUIREMENT_MARKER");
  });

  it("pins the first REAL user message, skipping projected reminder blocks", () => {
    const history: Message[] = [
      { role: "system", content: "sys prompt" },
      user(INTERNAL_BLOCK_USER),
      ...multiTurnHistory(user(LONG_INSTRUCTION)).slice(1),
    ];
    const result = compactMessages(history, { keepRecentTurns: 2 });

    expect(result.compacted).toBe(true);
    const out = result.messages!;
    expect(out[1]).toMatchObject({ role: "user", content: LONG_INSTRUCTION });
  });

  it("falls back to summarizing an oversized first message instead of pinning it", () => {
    const huge = "x".repeat(PINNED_INSTRUCTION_MAX_CHARS + 100);
    const result = compactMessages(multiTurnHistory(user(huge)), { keepRecentTurns: 2 });

    expect(result.compacted).toBe(true);
    const out = result.messages!;
    // No pinned user message before the summary.
    expect(out[1].role).toBe("system");
    expect(out[1].content).toContain("Previous conversation summary:");
  });
});

describe("compactWithLLM pinning", () => {
  function makeProvider(): { provider: Provider; complete: ReturnType<typeof vi.fn> } {
    const complete = vi.fn(async () => "summary of prior work");
    return { provider: { async *streamChat() {}, complete } as unknown as Provider, complete };
  }

  function toolGroup(callId: string, resultText: string): Message[] {
    return [
      { role: "assistant", content: "", toolCalls: [{ id: callId, name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: callId, content: resultText },
    ];
  }

  it("pins the original instruction verbatim and excludes it from summary fodder", async () => {
    const { provider, complete } = makeProvider();
    const history: Message[] = [
      { role: "system", content: "sys prompt" },
      user(LONG_INSTRUCTION),
      assistant("step one done"),
      user("continue"),
      ...toolGroup("a", "x".repeat(2000)),
      ...toolGroup("b", "y".repeat(2000)),
      ...toolGroup("c", "z".repeat(2000)),
    ];

    const result = await compactWithLLM(history, { provider, modelId: "fake" });

    expect(result.compacted).toBe(true);
    const out = result.messages!;
    expect(out[0]).toMatchObject({ role: "system", content: "sys prompt" });
    expect(out[1]).toMatchObject({ role: "user", content: LONG_INSTRUCTION });
    expect(out[2].role).toBe("user");
    expect(out[2].content).toContain(LLM_SUMMARY_PREFIX);
    expect(out[3]).toMatchObject({ role: "user", content: "continue" });

    // The compactor model never sees the pinned instruction as fodder.
    const historyText = (complete.mock.calls[0][0] as { content: string }[])[1].content;
    expect(historyText).not.toContain("IMPORTANT_LATE_REQUIREMENT_MARKER");
  });

  it("leaves the single-user-turn shape unchanged (first == last user)", async () => {
    const { provider } = makeProvider();
    const history: Message[] = [
      { role: "system", content: "sys prompt" },
      user("look at this project"),
      ...toolGroup("a", "x".repeat(2000)),
      ...toolGroup("b", "y".repeat(2000)),
      ...toolGroup("c", "z".repeat(2000)),
    ];

    const result = await compactWithLLM(history, { provider, modelId: "fake" });

    expect(result.compacted).toBe(true);
    const out = result.messages!;
    // Same shape as before the pin change: summary envelope, then the ask.
    expect(out[1].content).toContain(LLM_SUMMARY_PREFIX);
    expect(out[2]).toMatchObject({ role: "user", content: "look at this project" });
    // The ask appears exactly once — no duplicate pin.
    const askCount = out.filter((m) => m.role === "user" && m.content === "look at this project").length;
    expect(askCount).toBe(1);
  });
});
