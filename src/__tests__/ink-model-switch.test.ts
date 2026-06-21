import { describe, expect, it, vi } from "vitest";
import type { Provider, ThinkingLevel } from "../types.js";
import type { ProviderProfile } from "../provider-registry.js";
import {
  formatModelSwitchError,
  modelSwitchTarget,
  switchAgentModel,
  type ModelSwitchAgent,
  type ModelSwitchRegistry,
} from "../tui/model-switch.js";

const fakeProvider: Provider = {
  async *streamChat() {},
  async complete() {
    return "";
  },
};

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://chatgpt.com/backend-api",
    apiKey: "token",
    enabled: true,
    authType: "oauth",
    ...overrides,
  };
}

function agent(overrides: Partial<ModelSwitchAgent> = {}): ModelSwitchAgent {
  return {
    model: "openai:gpt-4o",
    providerId: "openai",
    thinking: "max",
    setProvider: vi.fn(),
    setSystemPrompt: vi.fn(),
    ...overrides,
  };
}

function registry(overrides: Partial<ModelSwitchRegistry> = {}): ModelSwitchRegistry {
  return {
    prepareProvider: vi.fn(async () => {}),
    getConfigured: () => [provider()],
    getDefault: () => provider(),
    ...overrides,
  };
}

describe("Ink model switching", () => {
  it("resolves model targets using the current provider fallback", () => {
    expect(modelSwitchTarget("gpt-5.5", "openai")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.5",
    });
    expect(modelSwitchTarget("deepseek:deepseek-v4-pro", "openai")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it("switches model only after provider preparation and instance creation succeed", async () => {
    const a = agent();
    const r = registry();
    const createProvider = vi.fn(() => fakeProvider);
    const rememberModel = vi.fn();
    const setThinkingLevel = vi.fn();
    const sessionManager = {
      updateMetadata: vi.fn(),
      appendMarker: vi.fn(),
    };

    const nextLevel = await switchAgentModel({
      model: "openai:gpt-5.5",
      agent: a,
      registry: r,
      createProvider,
      workingDir: "/repo",
      systemPromptOptions: { tools: ["read"] },
      rememberModel,
      setThinkingLevel,
      sessionManager,
    });

    expect(nextLevel).toBe("xhigh");
    expect(a.model).toBe("openai:gpt-5.5");
    expect(a.providerId).toBe("openai");
    expect(a.thinking).toBe("xhigh");
    expect(createProvider).toHaveBeenCalledWith("openai", "token", "https://chatgpt.com/backend-api");
    expect(a.setProvider).toHaveBeenCalledWith(fakeProvider);
    expect(a.setSystemPrompt).toHaveBeenCalledWith(expect.stringContaining("Configured model id: openai:gpt-5.5"));
    expect(rememberModel).toHaveBeenCalledWith("openai:gpt-5.5");
    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(sessionManager.updateMetadata).toHaveBeenCalledWith({
      model: "openai:gpt-5.5",
      thinkingLevel: "xhigh",
      reasoningEffort: "xhigh",
    });
    expect(sessionManager.appendMarker).toHaveBeenCalledWith("model_switch", "openai:gpt-5.5");
  });

  it("uses an explicitly selected thinking level from the model picker", async () => {
    const a = agent({ thinking: "medium" });
    const createProvider = vi.fn(() => fakeProvider);
    const setThinkingLevel = vi.fn();

    const nextLevel = await switchAgentModel({
      model: "deepseek:deepseek-v4-pro",
      thinkingLevel: "max",
      agent: a,
      registry: registry({
        getConfigured: () => [provider({
          id: "deepseek",
          name: "DeepSeek",
          baseURL: "https://api.deepseek.com",
        })],
        getDefault: () => provider({
          id: "deepseek",
          name: "DeepSeek",
          baseURL: "https://api.deepseek.com",
        }),
      }),
      createProvider,
      workingDir: "/repo",
      systemPromptOptions: {},
      rememberModel: vi.fn(),
      setThinkingLevel,
    });

    expect(nextLevel).toBe("max");
    expect(a.thinking).toBe("max");
    expect(setThinkingLevel).toHaveBeenCalledWith("max");
    expect(createProvider).toHaveBeenCalledWith("deepseek", "token", "https://api.deepseek.com");
  });

  it("does not mutate the agent when provider preparation fails", async () => {
    const a = agent({ thinking: "high" as ThinkingLevel });
    const createProvider = vi.fn(() => fakeProvider);
    const r = registry({
      prepareProvider: vi.fn(async () => {
        throw new Error("OAuth refresh failed");
      }),
    });

    await expect(switchAgentModel({
      model: "openai:gpt-5.5",
      agent: a,
      registry: r,
      createProvider,
      workingDir: "/repo",
      systemPromptOptions: {},
      rememberModel: vi.fn(),
      setThinkingLevel: vi.fn(),
    })).rejects.toThrow("OAuth refresh failed");

    expect(a.model).toBe("openai:gpt-4o");
    expect(a.providerId).toBe("openai");
    expect(a.thinking).toBe("high");
    expect(a.setProvider).not.toHaveBeenCalled();
    expect(a.setSystemPrompt).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(formatModelSwitchError("openai:gpt-5.5", new Error("OAuth refresh failed")))
      .toBe("Failed to switch model to gpt-5.5: OAuth refresh failed");
  });

  it("turns reused refresh token failures into a re-login hint", () => {
    const raw = `Token refresh failed: 401 Unauthorized - {
      "error": {
        "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
        "code": "refresh_token_reused"
      }
    }`;

    expect(formatModelSwitchError("openai:gpt-5.5", new Error(raw)))
      .toBe("Failed to switch model to gpt-5.5: OpenAI login expired. Run /login openai again to refresh your ChatGPT credentials.");
  });
});
