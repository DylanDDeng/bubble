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

  it("includes MiniMax agent models", () => {
    expect(getBuiltinProvider("minimax")).toMatchObject({
      name: "MiniMax Token Plan",
      baseURL: "https://api.minimaxi.com/anthropic",
      protocol: "anthropic-messages",
    });
    expect(getBuiltinProvider("minimax-openai")).toMatchObject({
      baseURL: "https://api.minimaxi.com/v1",
    });
    expect(listBuiltinModels("minimax").map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
      "M2-her",
    ]);
    expect(getAvailableThinkingLevels("minimax", "MiniMax-M3")).toEqual(["off", "medium"]);
    expect(getDefaultThinkingLevel("minimax", "MiniMax-M3")).toBe("medium");
    expect(getModelContextWindow("minimax", "MiniMax-M3")).toBe(1000000);
    expect(getModelContextWindow("minimax", "MiniMax-M2.7")).toBe(204800);
    expect(getModelContextWindow("minimax", "M2-her")).toBe(64000);
    expect(listBuiltinModels("minimax-openai").map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
      "M2-her",
    ]);
  });

  it("includes Anthropic Messages models", () => {
    expect(getBuiltinProvider("anthropic")).toMatchObject({
      baseURL: "https://api.anthropic.com",
      protocol: "anthropic-messages",
    });
    expect(listBuiltinModels("anthropic").map((model) => model.id)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    expect(getAvailableThinkingLevels("anthropic", "claude-opus-4-8")).toEqual(["off", "medium"]);
    expect(getDefaultThinkingLevel("anthropic", "claude-opus-4-8")).toBe("medium");
    expect(getModelContextWindow("anthropic", "claude-opus-4-8")).toBe(1000000);
  });
});
