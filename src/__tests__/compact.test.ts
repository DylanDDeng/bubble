import { describe, expect, it } from "vitest";
import { compactSessionEntries } from "../context/compact.js";
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
