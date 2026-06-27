import { describe, expect, it } from "vitest";
import {
  buildCompactedEntries,
  compactSessionEntries,
  planOldMessages,
  planSessionCompaction,
} from "../context/compact.js";
import type { SessionLogEntry } from "../session-types.js";

function user(id: string, content: string): SessionLogEntry {
  return {
    id,
    type: "user_message",
    message: { role: "user", content },
    timestamp: Number(id),
  };
}

function assistant(id: string, content: string): SessionLogEntry {
  return {
    id,
    type: "assistant_message",
    message: { role: "assistant", content },
    timestamp: Number(id),
  };
}

describe("compactSessionEntries", () => {
  it("keeps recent turns and replaces older history with a summary", () => {
    const entries: SessionLogEntry[] = [
      { id: "metadata", type: "metadata", metadata: { model: "openai:gpt-5.4" }, timestamp: 0 },
      user("1", "first task"),
      assistant("2", "first reply"),
      user("3", "second task"),
      assistant("4", "second reply"),
      user("5", "third task"),
      assistant("6", "third reply"),
    ];

    const result = compactSessionEntries(entries, { keepRecentTurns: 2 });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("Goal:");
    expect(result.entries?.some((entry) => entry.type === "summary")).toBe(true);
    expect(result.entries?.filter((entry) => entry.type === "user_message")).toHaveLength(2);
  });

  it("does nothing when there are not enough turns", () => {
    const entries: SessionLogEntry[] = [
      { id: "metadata", type: "metadata", metadata: { model: "openai:gpt-5.4" }, timestamp: 0 },
      user("1", "only one task"),
      assistant("2", "reply"),
    ];

    const result = compactSessionEntries(entries, { keepRecentTurns: 2 });
    expect(result.compacted).toBe(false);
  });
});

describe("planSessionCompaction / buildCompactedEntries (LLM path)", () => {
  const entries: SessionLogEntry[] = [
    { id: "metadata", type: "metadata", metadata: { model: "openai:gpt-5.4" }, timestamp: 0 },
    user("1", "first task"),
    assistant("2", "first reply"),
    user("3", "second task"),
    assistant("4", "second reply"),
    user("5", "third task"),
    assistant("6", "third reply"),
  ];

  it("plans the same split that the heuristic path uses", () => {
    const plan = planSessionCompaction(entries, { keepRecentTurns: 2 });
    expect(plan.compactable).toBe(true);
    if (!plan.compactable) return;
    // Two recent user turns kept; everything before the boundary is evicted.
    expect(plan.keptEntries.filter((e) => e.type === "user_message")).toHaveLength(2);
    expect(plan.oldEntries.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(planOldMessages(plan).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("injects a caller-supplied summary instead of the heuristic one", () => {
    const plan = planSessionCompaction(entries, { keepRecentTurns: 2 });
    if (!plan.compactable) throw new Error("expected compactable");
    const next = buildCompactedEntries(entries, plan, "LLM SUMMARY TEXT");

    const summaries = next.filter((e) => e.type === "summary");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { summary: string }).summary).toBe("LLM SUMMARY TEXT");
    // Metadata stays at the front; recent turns are preserved verbatim.
    expect(next[0].type).toBe("metadata");
    expect(next.filter((e) => e.type === "user_message")).toHaveLength(2);
  });

  it("reports not compactable when there aren't enough turns", () => {
    const short: SessionLogEntry[] = [user("1", "only one"), assistant("2", "reply")];
    expect(planSessionCompaction(short, { keepRecentTurns: 2 }).compactable).toBe(false);
  });
});
