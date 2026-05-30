import { describe, expect, it } from "vitest";
import { getBuiltinProvider, getModelContextWindow, listBuiltinModels } from "../model-catalog.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../variant/variant-resolver.js";
import { getNextThinkingLevel } from "../variant/thinking-level.js";

describe("variant resolver", () => {
  it("returns model-specific thinking levels", () => {
    expect(getAvailableThinkingLevels("openai-codex", "gpt-5.1-codex-mini")).toEqual(["off", "medium", "high"]);
    expect(getAvailableThinkingLevels("deepseek", "deepseek-v4-flash")).toEqual(["high", "max"]);
    expect(getAvailableThinkingLevels("deepseek", "deepseek-v4-pro")).toEqual(["high", "max"]);
  });

  it("uses the DeepSeek v4 documented context window", () => {
    expect(getModelContextWindow("deepseek", "deepseek-v4-flash")).toBe(1048576);
    expect(getModelContextWindow("deepseek", "deepseek-v4-pro")).toBe(1048576);
  });

  it("chooses medium as the default when supported", () => {
    expect(getDefaultThinkingLevel("openai-codex", "gpt-5.4")).toBe("medium");
    expect(getDefaultThinkingLevel("deepseek", "deepseek-v4-flash")).toBe("high");
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

  it("includes Alibaba DashScope qwen models", () => {
    expect(getBuiltinProvider("alibaba")).toMatchObject({
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    expect(listBuiltinModels("alibaba").map((model) => model.id)).toEqual([
      "qwen3.6-plus",
      "qwen3.7-max",
    ]);
    expect(getAvailableThinkingLevels("alibaba", "qwen3.7-max")).toEqual(["off"]);
    expect(getModelContextWindow("alibaba", "qwen3.6-plus")).toBe(1048576);
    expect(getModelContextWindow("alibaba", "qwen3.7-max")).toBe(1048576);
  });

  it("includes StepFun Step Plan reasoning models", () => {
    expect(getBuiltinProvider("stepfun")).toMatchObject({
      baseURL: "https://api.stepfun.com/step_plan/v1",
    });
    expect(listBuiltinModels("stepfun").map((model) => model.id)).toEqual([
      "step-3.7-flash",
      "step-3.5-flash-2603",
      "step-3.5-flash",
      "step-router-v1",
    ]);
    expect(getAvailableThinkingLevels("stepfun", "step-3.7-flash")).toEqual(["off", "low", "medium", "high"]);
    expect(getDefaultThinkingLevel("stepfun", "step-3.7-flash")).toBe("medium");
    expect(getModelContextWindow("stepfun", "step-3.7-flash")).toBe(256000);
  });
});
