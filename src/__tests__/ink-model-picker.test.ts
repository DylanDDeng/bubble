import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import {
  buildLocalModelOptions,
  clampPickerIndex,
  formatEffortPickerRow,
  formatModelPickerRow,
  formatNoModelResultsRow,
  formatReasoningLevelsLabel,
  formatSkillPickerRow,
  isPrintablePickerInput,
  modelPickerBodyRows,
  ModelPicker,
  padPickerRows,
  pickerWindowStart,
  preferredEffortIndex,
  resolvePickerKeyAction,
  shouldOpenEffortPicker,
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
    const deepseek = options.find((option) => option.id === "deepseek:deepseek-v4-pro");
    expect(deepseek?.reasoningLevels).toEqual(["high", "max"]);
    expect(formatReasoningLevelsLabel(deepseek?.reasoningLevels ?? [])).toBe("high/max");
    expect(shouldOpenEffortPicker(deepseek!)).toBe(true);
    expect(preferredEffortIndex(deepseek!, "xhigh")).toBe(0);
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

  it("keeps model picker body height stable across terminal sizes", () => {
    expect(modelPickerBodyRows(24)).toBe(10);
    expect(modelPickerBodyRows(20)).toBe(7);
    expect(modelPickerBodyRows(16)).toBe(3);
    expect(modelPickerBodyRows(8)).toBe(1);
  });

  it("clamps picker indexes without producing negative empty-list selections", () => {
    expect(clampPickerIndex(1, 0)).toBe(0);
    expect(clampPickerIndex(-3, 5)).toBe(0);
    expect(clampPickerIndex(9, 5)).toBe(4);
    expect(pickerWindowStart(0, 50, 10)).toBe(0);
    expect(pickerWindowStart(9, 50, 10)).toBe(4);
    expect(pickerWindowStart(49, 50, 10)).toBe(40);
    expect(pickerWindowStart(3, 4, 10)).toBe(0);
  });

  it("formats model picker rows as single fixed-width rows", () => {
    const row = formatModelPickerRow(
      {
        id: "gpt-5.5",
        label: "GPT 5.5 Reasoning Preview Model With A Long Display Name",
        providerBadge: "OpenAI",
        reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
      { selected: true, current: true, width: 56 },
    );

    expect(row).toHaveLength(56);
    expect(row).toContain("> GPT");
    expect(row).toContain("OpenAI");
    expect(row).toContain("●");
    expect(row).not.toContain("\n");
  });

  it("shows MiniMax thinking as on/off, leaving graded models as effort", () => {
    // MiniMax: the model row reads as a toggle, and the effort picker rows show on/off.
    const miniMaxRow = formatModelPickerRow(
      { id: "MiniMax-M3", label: "MiniMax M3", providerBadge: "minimax", reasoningLevels: ["off", "medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(miniMaxRow).toContain("thinking on/off");
    expect(miniMaxRow).not.toContain("medium");

    expect(formatEffortPickerRow("medium", { selected: true, width: 40, asToggle: true })).toContain("> on");
    expect(formatEffortPickerRow("off", { selected: false, width: 40, asToggle: true })).toContain("off");

    // A graded model (e.g. GLM toggle reuses off/medium, but isn't MiniMax) keeps level labels.
    const glmRow = formatModelPickerRow(
      { id: "glm-5.1", label: "GLM-5.1", providerBadge: "zhipuai", reasoningLevels: ["off", "medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(glmRow).toContain("off/medium");
  });

  it("shows thinking-only models as thinking, never a placeholder grade", () => {
    // kimi-k2.7-code: thinking can't be disabled and has no grades; the internal
    // "medium" placeholder level must not leak into the picker.
    expect(formatReasoningLevelsLabel(["medium"])).toBe("thinking");
    const kimiRow = formatModelPickerRow(
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", providerBadge: "kimi-for-coding", reasoningLevels: ["medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(kimiRow).toContain("thinking");
    expect(kimiRow).not.toContain("medium");

    // A single "off" level is genuinely no-thinking, not thinking-only.
    expect(formatReasoningLevelsLabel(["off"])).toBe("off");
  });

  it("formats effort and no-result rows with fixed viewport padding", () => {
    const effortRow = formatEffortPickerRow("xhigh", { selected: true, width: 36 });
    const rows = padPickerRows([
      formatNoModelResultsRow("a query that is too long to fit in the picker row", 36),
    ], 4, 36);

    expect(effortRow).toHaveLength(36);
    expect(effortRow).toContain("> xhigh");
    expect(effortRow).not.toContain("\n");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.length === 36)).toBe(true);
    expect(rows[1].trim()).toBe("");
  });

  it("renders empty model results inside the fixed picker viewport", () => {
    const output = renderToString(React.createElement(ModelPicker, {
      registry: fakeRegistry({ providers: [] }),
      current: "",
      currentThinkingLevel: "off",
      recent: [],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    }), { columns: 80 });

    expect(output).toContain("Select Model");
    expect(output).toContain("No models available");
    expect(output.split("\n").length).toBeGreaterThan(modelPickerBodyRows(24));
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
