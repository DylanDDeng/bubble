import { describe, expect, it } from "vitest";
import { getModelContextWindow } from "../model-catalog.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../variant/variant-resolver.js";
import { getNextThinkingLevel } from "../variant/thinking-level.js";

describe("variant resolver", () => {
  it("returns model-specific thinking levels", () => {
    expect(getAvailableThinkingLevels("openai-codex", "gpt-5.1-codex-mini")).toEqual(["off", "medium", "high"]);
    expect(getAvailableThinkingLevels("deepseek", "deepseek-v4-pro")).toEqual(["high", "max"]);
  });

  it("uses the DeepSeek v4 pro documented context window", () => {
    expect(getModelContextWindow("deepseek", "deepseek-v4-pro")).toBe(1048576);
  });

  it("chooses medium as the default when supported", () => {
    expect(getDefaultThinkingLevel("openai-codex", "gpt-5.4")).toBe("medium");
    expect(getDefaultThinkingLevel("deepseek", "deepseek-v4-pro")).toBe("high");
  });

  it("clamps unsupported levels downward", () => {
    expect(normalizeThinkingLevel("xhigh", ["off", "medium", "high"])).toBe("high");
    expect(normalizeThinkingLevel("minimal", ["off", "low", "medium"])).toBe("off");
  });

  it("cycles through only supported levels", () => {
    expect(getNextThinkingLevel("medium", ["off", "medium", "high"])).toBe("high");
    expect(getNextThinkingLevel("high", ["off", "medium", "high"])).toBe("off");
  });
});
