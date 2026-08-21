import { describe, expect, it, vi } from "vitest";
import {
  buildComposerSlashCommands,
  buildModelAutocompleteItems,
  buildProviderAutocompleteItems,
  ComposerAutocompleteProvider,
} from "../tui/composer-autocomplete.js";
import { localModelsForProvider } from "../tui/model-picker-data.js";

const modelCommand = {
  name: "model",
  description: "Switch model",
  source: "builtin" as const,
  handler: async () => {},
};

const providerCommand = {
  name: "provider",
  description: "Manage providers",
  source: "builtin" as const,
  handler: async () => {},
};

const openaiProvider = {
  id: "openai",
  name: "OpenAI",
  baseURL: "https://chatgpt.com/backend-api",
  apiKey: "token",
  enabled: true,
  authType: "oauth" as const,
};

function modelRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getEnabled: () => [openaiProvider],
    getConfigured: () => [openaiProvider],
    getDefault: () => openaiProvider,
    getModelConfig: () => ({ getCustomModels: () => [], hasProvider: () => false }),
    listModels: async () => [],
    ...overrides,
  } as any;
}

describe("pi-tui composer autocomplete", () => {
  it("orders renderer-local, builtin, skill, and MCP commands without shadowing executable names", () => {
    const commands = buildComposerSlashCommands(
      [
        { name: "help", description: "Show help", source: "builtin", handler: async () => {} },
        { name: "deploy", description: "Deploy prompt", source: "mcp", sourceLabel: "ops", handler: async () => {} },
      ],
      [
        { name: "podcast", description: "Create a podcast", source: "project" },
        { name: "help", description: "Must not shadow builtin", source: "project" },
      ],
    );

    expect(commands.map((command) => command.name)).toEqual(["fullscreen", "help", "podcast", "deploy"]);
    expect(commands.find((command) => command.name === "podcast")?.description).toContain("[skill · project]");
    expect(commands.find((command) => command.name === "deploy")?.description).toContain("[mcp:ops]");
  });

  it("reads dynamic command sources for every completion request", async () => {
    let includeMcp = false;
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [
        { name: "help", description: "Show help", source: "builtin", handler: async () => {} },
        ...(includeMcp
          ? [{ name: "deploy", description: "Deploy prompt", source: "mcp" as const, handler: async () => {} }]
          : []),
      ],
      skills: () => [],
    });

    const first = await provider.getSuggestions(["/dep"], 0, 4, { signal: new AbortController().signal });
    expect(first).toBeNull();

    includeMcp = true;
    const second = await provider.getSuggestions(["/dep"], 0, 4, { signal: new AbortController().signal });
    expect(second?.items.map((item) => item.value)).toEqual(["deploy"]);
  });

  it("does not suggest a fullscreen transition when fullscreen is already the root renderer", () => {
    const commands = buildComposerSlashCommands(
      [{ name: "help", description: "Show help", source: "builtin", handler: async () => {} }],
      [],
      "fullscreen",
    );

    expect(commands.map((command) => command.name)).toEqual(["help"]);
  });

  it("turns /model into an inline command with argument completions", () => {
    const completions = () => [{
      value: "openai:gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      submitOnSelect: true,
    }];
    const commands = buildComposerSlashCommands([modelCommand], [], "fullscreen", completions);
    const command = commands.find((entry) => entry.name === "model");

    expect(command).toMatchObject({
      name: "model",
      argumentHint: "<model>",
      submitOnSelect: false,
      argumentInputHint: {
        prompt: "⌕ ",
        placeholder: "Search models…",
        valuePrefix: "/model ",
      },
      keepArgumentMenuOnEmpty: true,
      argumentEmptyMessage: "No matching models",
    });
    expect(command?.getArgumentCompletions?.("")).toEqual(completions());
  });

  it("turns /provider into the same inline searchable command surface", () => {
    const completions = () => [{
      value: "--set openai",
      label: "OpenAI",
      submitOnSelect: true,
    }];
    const commands = buildComposerSlashCommands(
      [providerCommand],
      [],
      "fullscreen",
      undefined,
      completions,
    );
    const command = commands.find((entry) => entry.name === "provider");

    expect(command).toMatchObject({
      name: "provider",
      argumentHint: "<provider>",
      submitOnSelect: false,
      argumentInputHint: {
        prompt: "⌕ ",
        placeholder: "Search providers…",
        valuePrefix: "/provider ",
      },
      keepArgumentMenuOnEmpty: true,
      argumentEmptyMessage: "No matching providers",
    });
    expect(command?.getArgumentCompletions?.("")).toEqual(completions());
  });

  it("labels provider state, filters provider search, and highlights the current provider", async () => {
    const anthropic = {
      id: "anthropic",
      name: "Anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "anthropic-key",
      enabled: true,
    };
    const registry = modelRegistry({
      getConfigured: () => [openaiProvider, anthropic],
      getDefault: () => anthropic,
    });

    expect(buildProviderAutocompleteItems(registry, "anthropic", "openai")[0]).toEqual({
      value: "--set anthropic",
      label: "Anthropic",
      description: "anthropic · Configured",
      submitOnSelect: true,
    });

    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [providerCommand],
      skills: () => [],
      registry,
      providerId: () => "anthropic",
    });
    const suggestions = await provider.getSuggestions(["/provider "], 0, 10, {
      signal: new AbortController().signal,
    });

    expect(suggestions).toMatchObject({
      inputHint: {
        prompt: "⌕ ",
        placeholder: "Search providers…",
        valuePrefix: "/provider ",
      },
      preferredValue: "--set anthropic",
      keepOpenOnEmpty: true,
      emptyMessage: "No matching providers",
    });
    expect(suggestions?.items.find((item) => item.value === "--set anthropic")?.description)
      .toBe("Current · anthropic · Configured");
    expect(suggestions?.items.find((item) => item.value === "--add google"))
      .toMatchObject({ description: "google · Needs API key", submitOnSelect: true });
  });

  it("encodes provider ids in model completion values and filters by provider or model", () => {
    const items = buildModelAutocompleteItems([{
      provider: openaiProvider,
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerId: "openai" }],
    }], "sol");

    expect(items).toEqual([{
      value: "openai:gpt-5.6-sol --reasoning-effort ",
      label: "GPT-5.6 Sol",
      description: "OpenAI · gpt-5.6-sol",
      submitOnSelect: false,
    }]);
    expect(buildModelAutocompleteItems([{
      provider: openaiProvider,
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerId: "openai" }],
    }], "anthropic")).toEqual([]);
  });

  it("preserves builtin reasoning metadata in the local model catalog", () => {
    const model = localModelsForProvider(modelRegistry(), openaiProvider)
      .find((candidate) => candidate.id === "gpt-5.6-sol");

    expect(model).toMatchObject({
      providerId: "openai",
      reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningLevel: "low",
      contextWindow: 372000,
      useResponsesLite: true,
      toolOutputTokenLimit: 10000,
      tier: "balanced",
    });
  });

  it("switches multi-effort models to an inline effort phase and prefers the current effort", async () => {
    const model = {
      id: "gpt-test",
      name: "GPT Test",
      providerId: "openai",
      reasoningLevels: ["low", "medium", "high"] as const,
      defaultReasoningLevel: "medium" as const,
    };
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [modelCommand],
      skills: () => [],
      thinkingLevel: () => "high",
      registry: modelRegistry({
        getModelConfig: () => ({ getCustomModels: () => [model] }),
        listModels: async () => [model],
      }),
    });

    const models = await provider.getSuggestions(["/model "], 0, 7, {
      signal: new AbortController().signal,
    });
    expect(models?.items).toEqual([{
      value: "openai:gpt-test --reasoning-effort ",
      label: "GPT Test",
      description: "OpenAI · gpt-test",
      submitOnSelect: false,
    }]);

    const effort = await provider.getSuggestions(
      ["/model openai:gpt-test --reasoning-effort "],
      0,
      42,
      { signal: new AbortController().signal },
    );
    expect(effort).toMatchObject({
      inputHint: {
        prompt: "◆ ",
        placeholder: "Select reasoning effort…",
        valuePrefix: "/model openai:gpt-test --reasoning-effort ",
        backValue: "/model ",
      },
      preferredValue: "openai:gpt-test --reasoning-effort high",
    });
    expect(effort?.items.map(({ label, description, submitOnSelect }) => ({
      label,
      description,
      submitOnSelect,
    }))).toEqual([
      { label: "low", description: "light reasoning", submitOnSelect: true },
      { label: "medium", description: "balanced reasoning", submitOnSelect: true },
      { label: "high", description: "deeper reasoning", submitOnSelect: true },
    ]);
  });

  it("uses the model default when the current effort is unsupported", async () => {
    const model = {
      id: "gpt-test",
      name: "GPT Test",
      providerId: "openai",
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    };
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [modelCommand],
      skills: () => [],
      thinkingLevel: () => "minimal",
      registry: modelRegistry({
        getModelConfig: () => ({ getCustomModels: () => [model] }),
        listModels: async () => [model],
      }),
    });

    const effort = await provider.getSuggestions(
      ["/model openai:gpt-test --reasoning-effort "],
      0,
      42,
      { signal: new AbortController().signal },
    );
    expect(effort?.preferredValue).toBe("openai:gpt-test --reasoning-effort high");
  });

  it("renders toggle models as on/off and submits thinking-only models directly", () => {
    const toggleItems = buildModelAutocompleteItems([{
      provider: { ...openaiProvider, id: "kimi-for-coding", name: "Kimi" },
      models: [{
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        providerId: "kimi-for-coding",
        reasoningLevels: ["off", "medium"],
      }],
    }], "kimi-for-coding:kimi-k2.6 --reasoning-effort ");
    expect(toggleItems.map((item) => [item.label, item.description])).toEqual([
      ["off", "thinking disabled"],
      ["on", "thinking enabled"],
    ]);

    const thinkingOnly = buildModelAutocompleteItems([{
      provider: { ...openaiProvider, id: "kimi-for-coding", name: "Kimi" },
      models: [{
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        providerId: "kimi-for-coding",
        reasoningLevels: ["medium"],
      }],
    }]);
    expect(thinkingOnly[0]).toMatchObject({
      value: "kimi-for-coding:kimi-k2.7-code --reasoning-effort medium",
      submitOnSelect: true,
    });
  });

  it("returns local models immediately while remote discovery is still pending", async () => {
    let resolveRemote!: (models: Array<{ id: string; name: string; providerId: string }>) => void;
    const listModels = vi.fn(() => new Promise<Array<{ id: string; name: string; providerId: string }>>((resolve) => {
      resolveRemote = resolve;
    }));
    const onModelSuggestionsChanged = vi.fn();
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [modelCommand],
      skills: () => [],
      registry: modelRegistry({ listModels }),
      onModelSuggestionsChanged,
    });

    const initial = await provider.getSuggestions(["/model "], 0, 7, {
      signal: new AbortController().signal,
    });
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(initial?.items.some((item) => item.value === "openai:gpt-5.6-sol --reasoning-effort ")).toBe(true);
    expect(initial).toMatchObject({
      inputHint: { prompt: "⌕ ", placeholder: "Search models…", valuePrefix: "/model " },
      keepOpenOnEmpty: true,
      emptyMessage: "No matching models",
    });
    expect(onModelSuggestionsChanged).not.toHaveBeenCalled();

    const noMatch = await provider.getSuggestions(["/model anthropic"], 0, 18, {
      signal: new AbortController().signal,
    });
    expect(noMatch).toMatchObject({ items: [], keepOpenOnEmpty: true, emptyMessage: "No matching models" });

    resolveRemote([{ id: "remote-only", name: "Remote Only", providerId: "openai" }]);
    await vi.waitFor(() => expect(onModelSuggestionsChanged).toHaveBeenCalledTimes(1));
    const refreshed = await provider.getSuggestions(["/model remote"], 0, 13, {
      signal: new AbortController().signal,
    });
    expect(refreshed?.items.map((item) => item.value)).toEqual([
      "openai:remote-only --reasoning-effort off",
    ]);
  });

  it("starts discovery for all enabled providers concurrently", async () => {
    const starts: string[] = [];
    const providers = [
      openaiProvider,
      { ...openaiProvider, id: "grok", name: "Grok", baseURL: "https://api.x.ai" },
    ];
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [modelCommand],
      skills: () => [],
      registry: modelRegistry({
        getEnabled: () => providers,
        listModels: (configured: { id: string }) => {
          starts.push(configured.id);
          return new Promise(() => {});
        },
      }),
    });

    await provider.getSuggestions(["/model "], 0, 7, { signal: new AbortController().signal });
    expect(starts).toEqual(["openai", "grok"]);
  });
});
