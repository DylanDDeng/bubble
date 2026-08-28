import { describe, expect, it } from "vitest";
import { resolveConfiguredModel } from "../model-selection.js";

describe("resolveConfiguredModel", () => {
  it("lets an explicit CLI model override session and user defaults", () => {
    expect(resolveConfiguredModel({
      cliModel: "minimax:MiniMax-M3",
      sessionModel: "openai:gpt-5.4",
      defaultModel: "openai:gpt-5.5",
      fallbackProviderId: "openai",
    })).toBe("minimax:MiniMax-M3");
  });

  it("uses the session model before the user default when no CLI model is provided", () => {
    expect(resolveConfiguredModel({
      sessionModel: "deepseek:deepseek-v4-pro",
      defaultModel: "openai:gpt-5.5",
      fallbackProviderId: "openai",
    })).toBe("deepseek:deepseek-v4-pro");
  });

  it("falls back to the user default when no CLI or session model exists", () => {
    expect(resolveConfiguredModel({
      defaultModel: "openai:gpt-5.5",
      fallbackProviderId: "minimax",
    })).toBe("openai:gpt-5.5");
  });

  it("qualifies plain model ids with the fallback provider", () => {
    expect(resolveConfiguredModel({
      cliModel: "MiniMax-M3",
      defaultModel: "openai:gpt-5.5",
      fallbackProviderId: "minimax",
    })).toBe("minimax:MiniMax-M3");
  });

  it("rejects non-Ox models for the fixed OpenRouter provider", () => {
    expect(() => resolveConfiguredModel({
      cliModel: "openrouter:openai/gpt-5.6",
      fallbackProviderId: "openrouter",
    })).toThrow(/openrouter.*fixed.*stealth\/ox-alpha/i);
    expect(() => resolveConfiguredModel({
      cliModel: "openai/gpt-5.6",
      fallbackProviderId: "openrouter",
    })).toThrow(/openrouter.*fixed.*stealth\/ox-alpha/i);
  });

  it("accepts Ox Alpha through explicit and fallback OpenRouter routes", () => {
    expect(resolveConfiguredModel({
      cliModel: "openrouter:stealth/ox-alpha",
      fallbackProviderId: "openai",
    })).toBe("openrouter:stealth/ox-alpha");
    expect(resolveConfiguredModel({
      cliModel: "stealth/ox-alpha",
      fallbackProviderId: "openrouter",
    })).toBe("openrouter:stealth/ox-alpha");
  });
});
