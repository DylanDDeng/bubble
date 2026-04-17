import { describe, expect, it } from "vitest";
import { isContextOverflowByUsage, isContextOverflowError } from "../context/overflow.js";

describe("isContextOverflowError", () => {
  it("matches OpenAI / Kimi overflow phrasing", () => {
    expect(isContextOverflowError(new Error("400 context_length_exceeded: ..."))).toBe(true);
    expect(isContextOverflowError(new Error("Your input exceeds the context window of this model."))).toBe(true);
    expect(isContextOverflowError(new Error("input exceeds the limit of 32768 tokens"))).toBe(true);
    expect(isContextOverflowError(new Error("Prompt is too long"))).toBe(true);
  });

  it("matches nested error messages", () => {
    const err = {
      message: "400",
      error: { message: "context_length_exceeded" },
    };
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches Error.cause chain", () => {
    const inner = new Error("maximum context length reached");
    const outer = new Error("request failed", { cause: inner });
    expect(isContextOverflowError(outer)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isContextOverflowError(new Error("401 invalid api key"))).toBe(false);
    expect(isContextOverflowError(new Error("network timeout"))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});

describe("isContextOverflowByUsage", () => {
  it("returns true when input exceeds window", () => {
    expect(isContextOverflowByUsage(33000, 32000)).toBe(true);
  });

  it("returns false under the window", () => {
    expect(isContextOverflowByUsage(10000, 32000)).toBe(false);
  });

  it("handles missing values gracefully", () => {
    expect(isContextOverflowByUsage(undefined, 32000)).toBe(false);
    expect(isContextOverflowByUsage(10000, undefined)).toBe(false);
  });
});
