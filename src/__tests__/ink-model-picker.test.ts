import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import {
  buildLocalModelOptions,
  formatSkillPickerRow,
  isPrintablePickerInput,
  resolvePickerKeyAction,
  truncateVisual,
} from "../tui-ink/model-picker.js";

describe("Ink model picker", () => {
  it("builds initial options from local metadata without remote model discovery", () => {
    const listModels = vi.fn(async () => {
      throw new Error("remote discovery should not block initial render");
    });
    const registry = fakeRegistry({
      providers: [
        provider({ id: "openai", name: "OpenAI", authType: "oauth" }),
        provider({ id: "deepseek", name: "DeepSeek" }),
        provider({ id: "fireworks", name: "Fireworks" }),
      ],
      customModels: {
        fireworks: [{ id: "accounts/fireworks/models/kimi-k2p6", name: "Kimi-K2.6", providerId: "fireworks" }],
      },
      listModels,
    });

    const options = buildLocalModelOptions(registry, "openai:gpt-5.4", ["deepseek:deepseek-v4-pro"]);

    expect(listModels).not.toHaveBeenCalled();
    expect(options.map((option) => option.id)).toContain("deepseek:deepseek-v4-pro");
    expect(options.map((option) => option.id)).toContain("openai:gpt-5.4");
    expect(options.map((option) => option.id)).toContain("fireworks:accounts/fireworks/models/kimi-k2p6");
  });

  it("normalizes raw arrow sequences for picker navigation", () => {
    expect(resolvePickerKeyAction("", { upArrow: true })).toBe("up");
    expect(resolvePickerKeyAction("\x1b[A", {})).toBe("up");
    expect(resolvePickerKeyAction("[B", {})).toBe("down");
    expect(resolvePickerKeyAction("\x1b[1;5A", {})).toBe("up");
    expect(resolvePickerKeyAction("OB", {})).toBe("down");
  });

  it("does not treat terminal control sequences as searchable picker text", () => {
    expect(isPrintablePickerInput("p")).toBe(true);
    expect(isPrintablePickerInput("podcast")).toBe(true);
    expect(isPrintablePickerInput("\x1b[A")).toBe(false);
    expect(isPrintablePickerInput("[B")).toBe(false);
    expect(isPrintablePickerInput("OB")).toBe(false);
    expect(isPrintablePickerInput("\x1b[<64;12;5M")).toBe(false);
    expect(isPrintablePickerInput("[<64;12;5M")).toBe(false);
    expect(isPrintablePickerInput(`\x1b[M${String.fromCharCode(64 + 32)}!!`)).toBe(false);
  });

  it("formats skill picker rows as fixed-height truncated rows", () => {
    const row = formatSkillPickerRow(
      {
        name: "agent-browser",
        description: "Browser automation CLI for AI agents. Use when the user needs to interact with websites.",
      },
      { selected: true, width: 48 },
    );

    expect(row).toHaveLength(48);
    expect(row).toContain("> agent-browser");
    expect(row.endsWith("…") || row.endsWith(" ")).toBe(true);
    expect(row).not.toContain("\n");
  });

  it("truncates visual text with wide characters", () => {
    expect(truncateVisual("文章打分和优化", 6)).toBe("文章…");
  });
});

function provider(input: Partial<ProviderProfile> & Pick<ProviderProfile, "id" | "name">): ProviderProfile {
  return {
    baseURL: "https://example.com",
    apiKey: "sk-test",
    enabled: true,
    ...input,
  };
}

function fakeRegistry(input: {
  providers: ProviderProfile[];
  customModels?: Record<string, Array<{ id: string; name?: string; providerId: string }>>;
  listModels?: ProviderRegistry["listModels"];
}): ProviderRegistry {
  return {
    getEnabled: () => input.providers,
    getModelConfig: () => ({
      getCustomModels: (providerId: string) => input.customModels?.[providerId] ?? [],
    }),
    listModels: input.listModels,
  } as unknown as ProviderRegistry;
}
