import { describe, expect, it } from "vitest";
import { pushHistoryEntry, stepHistory } from "../tui/input-history.js";

describe("input history navigation", () => {
  const history = ["first", "second", "third"];

  it("up from draft snapshots current text and shows newest entry", () => {
    const result = stepHistory({ history, index: null, draft: "" }, "up", "draft-in-progress");
    expect(result).toEqual({
      text: "third",
      index: 2,
      draft: "draft-in-progress",
      changed: true,
    });
  });

  it("up walks backwards without overwriting saved draft", () => {
    const result = stepHistory({ history, index: 2, draft: "draft" }, "up", "third-edited");
    expect(result.text).toBe("second");
    expect(result.index).toBe(1);
    expect(result.draft).toBe("draft");
    expect(result.changed).toBe(true);
  });

  it("up at oldest entry is a no-op", () => {
    const result = stepHistory({ history, index: 0, draft: "draft" }, "up", "first");
    expect(result.changed).toBe(false);
    expect(result.index).toBe(0);
  });

  it("up with empty history is a no-op", () => {
    const result = stepHistory({ history: [], index: null, draft: "" }, "up", "anything");
    expect(result.changed).toBe(false);
  });

  it("down moves forward through history", () => {
    const result = stepHistory({ history, index: 0, draft: "draft" }, "down", "first");
    expect(result.text).toBe("second");
    expect(result.index).toBe(1);
  });

  it("down past newest restores the saved draft and clears it", () => {
    const result = stepHistory({ history, index: 2, draft: "draft" }, "down", "third");
    expect(result.text).toBe("draft");
    expect(result.index).toBeNull();
    expect(result.draft).toBe("");
    expect(result.changed).toBe(true);
  });

  it("down past newest with empty draft yields blank composer", () => {
    const result = stepHistory({ history, index: 2, draft: "" }, "down", "third");
    expect(result.text).toBe("");
    expect(result.index).toBeNull();
    expect(result.changed).toBe(true);
  });

  it("down while editing a draft is a no-op", () => {
    const result = stepHistory({ history, index: null, draft: "" }, "down", "typing");
    expect(result.changed).toBe(false);
    expect(result.text).toBe("typing");
  });
});

describe("pushHistoryEntry", () => {
  it("appends a new entry", () => {
    expect(pushHistoryEntry(["a"], "b")).toEqual(["a", "b"]);
  });

  it("dedupes consecutive identical entries", () => {
    const history = ["a", "b"];
    expect(pushHistoryEntry(history, "b")).toBe(history);
  });

  it("ignores empty / whitespace-only entries", () => {
    const history = ["a"];
    expect(pushHistoryEntry(history, "")).toBe(history);
    expect(pushHistoryEntry(history, "   \n  ")).toBe(history);
  });

  it("keeps non-consecutive duplicates", () => {
    expect(pushHistoryEntry(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });
});
