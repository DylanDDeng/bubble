import { describe, expect, it } from "vitest";
import { applyCardBudget, clampBlocksToElementBudget, truncateToBytes, utf8Bytes } from "../card/budget.js";
import { createInitialRunState } from "../card/run-state-types.js";

function makeState() {
  return createInitialRunState({
    scope: { chatId: "oc_b", userId: "ou_b", displayName: "b", cwd: "/" },
    mode: "default",
  });
}

describe("truncateToBytes", () => {
  it("leaves short strings intact", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
  });

  it("truncates ascii to byte limit", () => {
    const truncated = truncateToBytes("a".repeat(50), 10);
    expect(utf8Bytes(truncated)).toBeLessThanOrEqual(10);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("respects multi-byte boundaries", () => {
    // 中 = 3 bytes utf-8
    const truncated = truncateToBytes("中".repeat(20), 10);
    expect(utf8Bytes(truncated)).toBeLessThanOrEqual(10);
  });
});

describe("clampBlocksToElementBudget", () => {
  it("truncates a giant text block", () => {
    const state = makeState();
    state.blocks.push({ kind: "text", text: "x".repeat(50_000), streaming: false });
    clampBlocksToElementBudget(state, 1000);
    const block = state.blocks[0];
    if (block?.kind === "text") {
      expect(utf8Bytes(block.text)).toBeLessThanOrEqual(1000);
    }
  });

  it("truncates a tool block's resultPreview", () => {
    const state = makeState();
    state.blocks.push({
      kind: "tool",
      id: "t1",
      name: "Read",
      argsPreview: "path=/x",
      status: "ok",
      resultPreview: "y".repeat(20_000),
      startedAt: 0,
    });
    clampBlocksToElementBudget(state, 4000);
    const block = state.blocks[0];
    if (block?.kind === "tool" && block.resultPreview) {
      expect(utf8Bytes(block.resultPreview)).toBeLessThanOrEqual(4000);
    }
  });
});

describe("applyCardBudget", () => {
  it("collapses older tool blocks when total exceeds card budget", () => {
    const state = makeState();
    // Add 10 large tool blocks
    for (let i = 0; i < 10; i++) {
      state.blocks.push({
        kind: "tool",
        id: `t${i}`,
        name: "Bash",
        argsPreview: "x".repeat(500),
        status: "ok",
        resultPreview: "y".repeat(2000),
        startedAt: i,
      });
    }
    applyCardBudget(state, { maxBytesPerElement: 5000, maxBytesPerCard: 8000 });
    // The newest 2 tools keep their bodies; older ones get trimmed.
    const olderTools = state.blocks.slice(0, -2).filter((b) => b.kind === "tool");
    for (const t of olderTools) {
      if (t.kind === "tool" && t.resultPreview) {
        expect(t.resultPreview.length).toBeLessThanOrEqual(220);
      }
    }
  });

  it("never drops the most recent block", () => {
    const state = makeState();
    state.blocks.push({ kind: "text", text: "old context " + "x".repeat(100_000), streaming: false });
    state.blocks.push({ kind: "text", text: "newest", streaming: false });
    applyCardBudget(state, { maxBytesPerElement: 1000, maxBytesPerCard: 2000 });
    // Last block intact.
    const last = state.blocks[state.blocks.length - 1];
    expect(last?.kind).toBe("text");
    if (last?.kind === "text") {
      expect(last.text).toContain("newest");
    }
  });
});
