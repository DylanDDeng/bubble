import { describe, expect, it } from "vitest";
import { resolveRequestTimeoutMs, MAX_TIMER_MS } from "../provider.js";

describe("resolveRequestTimeoutMs", () => {
  it("defaults to the largest SDK-safe 32-bit timer, never Number.MAX_SAFE_INTEGER", () => {
    const t = resolveRequestTimeoutMs(undefined);
    expect(t).toBe(MAX_TIMER_MS);
    // The sentinel must leave headroom for the OpenAI SDK's internal
    // `timeout + 1000` (core.js minAgentTimeout): at exactly 2**31-1 that
    // addition overflows Node's timers (TimeoutOverflowWarning + clamp).
    expect(t).toBe(2 ** 31 - 1 - 1000);
    expect(t + 1000).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(t).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("honors a valid operator override", () => {
    expect(resolveRequestTimeoutMs("30000")).toBe(30000);
    expect(resolveRequestTimeoutMs("1")).toBe(1);
  });

  it("clamps an over-large override into the 32-bit range", () => {
    expect(resolveRequestTimeoutMs(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_TIMER_MS);
    expect(resolveRequestTimeoutMs("999999999999")).toBe(MAX_TIMER_MS);
  });

  it("falls back to the default for invalid / non-positive input", () => {
    for (const raw of ["", "  ", "0", "-5", "abc", "12.5", "NaN"]) {
      expect(resolveRequestTimeoutMs(raw)).toBe(MAX_TIMER_MS);
    }
  });
});
