import { describe, expect, it, vi } from "vitest";
import { compactMessagesWithLLM } from "../context/compact-llm.js";
import type { Message, Provider } from "../types.js";

function makeProvider(completeImpl: Provider["complete"]): Provider {
  return {
    async *streamChat() {
      // Not used in these tests.
    },
    complete: completeImpl,
  };
}

const history: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "first task" },
  { role: "assistant", content: "working" },
  { role: "user", content: "second task" },
  { role: "assistant", content: "done" },
  { role: "user", content: "third task" },
  { role: "assistant", content: "ok" },
];

describe("compactMessagesWithLLM", () => {
  it("summarizes via the provider and preserves recent turns", async () => {
    const complete = vi.fn(async () => "1. Primary Request\n- fake summary");
    const provider = makeProvider(complete);
    const result = await compactMessagesWithLLM(history, {
      provider,
      model: "fake",
      keepRecentTurns: 1,
    });
    expect(result.compacted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(result.messages).toBeDefined();
    const systems = result.messages!.filter((m) => m.role === "system");
    expect(systems.some((m) => m.content.includes("Previous conversation summary:"))).toBe(true);
    expect(systems.some((m) => m.content.includes("fake summary"))).toBe(true);
    const users = result.messages!.filter((m) => m.role === "user");
    expect(users.map((m) => (m as any).content)).toEqual(["third task"]);
  });

  it("falls back to heuristic compaction when the provider throws", async () => {
    const provider = makeProvider(async () => {
      throw new Error("provider exploded");
    });
    const result = await compactMessagesWithLLM(history, {
      provider,
      model: "fake",
      keepRecentTurns: 1,
    });
    expect(result.compacted).toBe(true);
    // Heuristic summary includes "Goal:" header.
    expect(result.summary).toContain("Goal:");
  });

  it("returns compacted=false when there is nothing old to summarize", async () => {
    const tiny: Message[] = [
      { role: "user", content: "only turn" },
      { role: "assistant", content: "ok" },
    ];
    const provider = makeProvider(async () => "summary");
    const result = await compactMessagesWithLLM(tiny, {
      provider,
      model: "fake",
      keepRecentTurns: 2,
    });
    expect(result.compacted).toBe(false);
  });
});
