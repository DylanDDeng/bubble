import { describe, expect, it } from "vitest";
import { compactionFraction, renderBar } from "../tui-ink/compaction-progress.js";

describe("compactionFraction", () => {
  it("is small while collecting", () => {
    expect(compactionFraction({ phase: "collecting", streamedChars: 0 })).toBeCloseTo(0.05);
  });

  it("ramps with streamed chars but never reaches the 0.9 ceiling early", () => {
    const small = compactionFraction({ phase: "summarizing", streamedChars: 200 });
    const big = compactionFraction({ phase: "summarizing", streamedChars: 5000 });
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(0.1);
    // Honest progress: a single LLM call can't be "done" until it returns.
    expect(big).toBeLessThanOrEqual(0.9);
    expect(compactionFraction({ phase: "summarizing", streamedChars: 1_000_000 })).toBeLessThanOrEqual(0.9);
  });

  it("snaps to 0.95 on apply, leaving the last sliver for actual completion", () => {
    expect(compactionFraction({ phase: "applying", streamedChars: 3000 })).toBeCloseTo(0.95);
  });
});

describe("renderBar", () => {
  it("fills proportionally and pads the remainder", () => {
    const { filled, empty } = renderBar(0.5, 10);
    expect(filled.length + empty.length).toBe(10);
    expect(filled.length).toBe(5);
  });

  it("clamps out-of-range fractions", () => {
    expect(renderBar(-1, 8).filled).toBe("");
    expect(renderBar(2, 8).empty).toBe("");
  });
});
