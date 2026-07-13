import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import type { ThinkingLevel } from "../types.js";
import {
  buildModelPickerDisplayItems,
  buildMergedModelOptions,
  buildLocalModelOptions,
  clampPickerIndex,
  filterAndRankModelPickerOptions,
  formatEffortPickerRow,
  formatModelDiscoveryStatus,
  formatModelPickerRow,
  formatNoModelResultsRow,
  formatReasoningLevelsLabel,
  formatSkillPickerRow,
  isPrintablePickerInput,
  isModelOptionSelectable,
  modelPickerBodyRows,
  modelPickerFamilyKey,
  modelPickerRecentKey,
  ModelPicker,
  moveModelSelection,
  padPickerRows,
  pickerWindowStart,
  preferredEffortIndex,
  reconcileModelPickerPhase,
  resolveModelPickerDisplayIndex,
  resolveSelectedModelId,
  resolvePickerKeyAction,
  shouldOpenEffortPicker,
  truncateVisual,
  type ModelPickerOption,
  type ModelProviderDiscoveryState,
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
    const sol = options.find((option) => option.id === "openai:gpt-5.6-sol");
    expect(sol).toMatchObject({
      reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningLevel: "low",
      contextWindow: 372000,
      toolOutputTokenLimit: 10000,
      available: true,
    });
    expect(options.map((option) => option.id)).toContain("fireworks:accounts/fireworks/models/kimi-k2p6");
  });

  it("treats an authoritative provider result as the catalog while preserving pinned rows", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const localModels: ModelInfo[] = [
      model("gpt-5.6-sol", ["low", "medium"], "low"),
      model("gpt-5.6-terra", ["low", "medium"], "medium"),
      model("gpt-5.6-luna", ["low", "medium"], "medium"),
      model("gpt-retired", ["off"], "off"),
    ];
    const discoveries = new Map<string, ModelProviderDiscoveryState>([["openai", {
      status: "complete",
      source: "remote",
      authoritative: true,
      models: [
        {
          ...model("gpt-5.6-sol", ["low", "medium", "high"], "medium"),
          name: "GPT-5.6-Sol remote",
          contextWindow: 999000,
          toolOutputTokenLimit: 12345,
        },
        model("gpt-5.6-terra", ["low", "medium", "high"], "medium"),
      ],
    }]]);

    const options = buildMergedModelOptions({
      providers: [openai],
      localModelsByProvider: new Map([["openai", localModels]]),
      discoveries,
      current: "openai:gpt-5.6-sol",
      recent: ["openai:gpt-5.6-sol", "openai:gpt-retired"],
    });

    expect(options.map((item) => item.id)).toEqual([
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
      "openai:gpt-retired",
    ]);
    expect(options.filter((item) => item.id === "openai:gpt-5.6-sol")).toHaveLength(1);
    expect(options[0]).toMatchObject({
      label: "GPT-5.6-Sol remote",
      group: "Current",
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "medium",
      contextWindow: 999000,
      toolOutputTokenLimit: 12345,
      available: true,
    });
    expect(options[1]).toMatchObject({ group: "Current", available: true, pending: false });
    expect(options[2]).toMatchObject({ group: "Recent", available: false, pending: false });
    expect(options.map((item) => item.id)).not.toContain("openai:gpt-5.6-luna");
  });

  it("promotes a complete recent GPT-5.6 family in authoritative catalog order", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const deepseek = provider({ id: "deepseek", name: "DeepSeek" });
    const discoveries = new Map<string, ModelProviderDiscoveryState>([["openai", {
      status: "complete",
      source: "remote",
      authoritative: true,
      models: [
        model("gpt-5.6-sol", ["low", "medium"], "low"),
        model("gpt-5.6-terra", ["low", "medium"], "medium"),
        model("gpt-5.6-luna", ["low", "medium"], "medium"),
        model("gpt-5.5", ["low", "medium"], "medium"),
        model("gpt-5.4", ["low", "medium"], "medium"),
      ],
    }]]);

    const options = buildMergedModelOptions({
      providers: [openai, deepseek],
      localModelsByProvider: new Map([
        ["openai", []],
        ["deepseek", [{ ...model("deepseek-v4-pro", ["high", "max"], "high"), providerId: "deepseek" }]],
      ]),
      discoveries,
      current: "deepseek:deepseek-v4-pro",
      recent: [
        "deepseek:deepseek-v4-pro",
        "openai:gpt-5.6-luna",
        "openai:gpt-5.6-sol",
        "openai:gpt-5.5",
      ],
    });

    expect(options.map((item) => item.id)).toEqual([
      "deepseek:deepseek-v4-pro",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
      "openai:gpt-5.6-luna",
      "openai:gpt-5.5",
      "openai:gpt-5.4",
    ]);
    expect(options.slice(1, 5).every((item) => item.group === "Recent")).toBe(true);
    expect(options.filter((item) => item.id === "openai:gpt-5.6-luna")).toHaveLength(1);
  });

  it("limits promotion to three recent families and leaves provider order stable", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const remoteModels = [
      model("gpt-5.3-codex", ["low"], "low"),
      model("gpt-5.6-sol", ["low"], "low"),
      model("gpt-5.6-terra", ["low"], "low"),
      model("gpt-5.6-luna", ["low"], "low"),
      model("gpt-5.5", ["low"], "low"),
      model("gpt-5.4", ["low"], "low"),
    ];
    const options = buildMergedModelOptions({
      providers: [openai],
      localModelsByProvider: new Map([["openai", remoteModels]]),
      discoveries: new Map([["openai", {
        status: "complete" as const,
        source: "remote" as const,
        authoritative: true,
        models: remoteModels,
      }]]),
      current: "",
      recent: [
        "openai:gpt-5.6-luna",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.5",
        "openai:gpt-5.4",
        "openai:gpt-5.3-codex",
      ],
    });

    expect(options.map((item) => item.id)).toEqual([
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
      "openai:gpt-5.6-luna",
      "openai:gpt-5.5",
      "openai:gpt-5.4",
      "openai:gpt-5.3-codex",
    ]);
    expect(options.slice(0, 5).every((item) => item.group === "Recent")).toBe(true);
    expect(options[5].group).toBe("OpenAI");
  });

  it("does not infer GPT families for API-key providers", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "api" });
    const models = [
      model("gpt-5.6-sol", ["low"], "low"),
      model("gpt-5.6-terra", ["low"], "low"),
      model("gpt-5.6-luna", ["low"], "low"),
    ];
    const options = buildMergedModelOptions({
      providers: [openai],
      localModelsByProvider: new Map([["openai", models]]),
      discoveries: new Map(),
      current: "",
      recent: ["openai:gpt-5.6-luna"],
    });

    expect(options.map((item) => item.id)).toEqual([
      "openai:gpt-5.6-luna",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
    ]);
  });

  it("never restores family siblings omitted by an authoritative catalog", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const localModels = [
      model("gpt-5.6-sol", ["low"], "low"),
      model("gpt-5.6-terra", ["low"], "low"),
      model("gpt-5.6-luna", ["low"], "low"),
    ];
    const options = buildMergedModelOptions({
      providers: [openai],
      localModelsByProvider: new Map([["openai", localModels]]),
      discoveries: new Map([["openai", {
        status: "complete" as const,
        source: "remote" as const,
        authoritative: true,
        models: [model("gpt-5.6-sol", ["low"], "low")],
      }]]),
      current: "openai:gpt-5.6-sol",
      recent: ["openai:gpt-5.6-sol", "openai:gpt-5.6-luna"],
    });

    expect(options.map((item) => item.id)).toEqual([
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-luna",
    ]);
    expect(options.find((item) => item.id === "openai:gpt-5.6-luna")).toMatchObject({
      group: "Recent",
      available: false,
      pending: false,
    });
    expect(options.map((item) => item.id)).not.toContain("openai:gpt-5.6-terra");
  });

  it("uses a conservative provider-scoped family key", () => {
    const oauth = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const api = provider({ id: "openai", name: "OpenAI", authType: "api" });
    const solFamily = modelPickerFamilyKey(oauth, "gpt-5.6-sol");

    expect(modelPickerFamilyKey(oauth, "gpt-5.6-terra")).toBe(solFamily);
    expect(modelPickerFamilyKey(oauth, "gpt-5.6-luna")).toBe(solFamily);
    expect(modelPickerFamilyKey(oauth, "gpt-5.7-sol")).not.toBe(solFamily);
    expect(modelPickerFamilyKey(oauth, "gpt-5.4-mini")).not.toBe(modelPickerFamilyKey(oauth, "gpt-5.4"));
    expect(modelPickerFamilyKey(api, "gpt-5.6-sol")).not.toBe(modelPickerFamilyKey(api, "gpt-5.6-terra"));
  });

  it("rebuilds provider sections in provider order, independent of completion order", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const deepseek = provider({ id: "deepseek", name: "DeepSeek" });
    const discoveries = new Map<string, ModelProviderDiscoveryState>();
    discoveries.set("deepseek", {
      status: "complete",
      source: "remote",
      authoritative: true,
      models: [{ ...model("deepseek-v4-pro", ["high", "max"], "high"), providerId: "deepseek" }],
    });
    discoveries.set("openai", {
      status: "complete",
      source: "remote",
      authoritative: true,
      models: [model("gpt-5.6-sol", ["low", "medium"], "low")],
    });

    const options = buildMergedModelOptions({
      providers: [openai, deepseek],
      localModelsByProvider: new Map(),
      discoveries,
      current: "",
      recent: [],
    });

    expect(options.map((item) => item.id)).toEqual([
      "openai:gpt-5.6-sol",
      "deepseek:deepseek-v4-pro",
    ]);
  });

  it("keeps unknown recent models pending without inventing off effort", () => {
    const openai = provider({ id: "openai", name: "OpenAI", authType: "oauth" });
    const options = buildMergedModelOptions({
      providers: [openai],
      localModelsByProvider: new Map([["openai", [model("gpt-5.6-sol", ["low"], "low")]]]),
      discoveries: new Map(),
      current: "openai:gpt-unknown",
      recent: ["openai:gpt-unknown"],
    });

    expect(options[0]).toMatchObject({
      id: "openai:gpt-unknown",
      reasoningLevels: [],
      available: false,
      pending: true,
    });
    expect(formatModelPickerRow(options[0], { selected: false, current: true, width: 64 })).toContain("checking");
    expect(isModelOptionSelectable(options[0])).toBe(false);
    expect(resolveSelectedModelId(options, options[0].id)).toBe("openai:gpt-5.6-sol");
  });

  it("preserves selection by model id and skips unavailable rows", () => {
    const options = [
      option("openai:retired", ["off"], { available: false }),
      option("openai:gpt-a", ["low"]),
      option("openai:gpt-b", ["low"]),
    ];

    expect(resolveSelectedModelId(options, "openai:gpt-b")).toBe("openai:gpt-b");
    expect(resolveSelectedModelId(options, "openai:retired")).toBe("openai:gpt-a");
    expect(moveModelSelection(options, "openai:gpt-b", -1)).toBe("openai:gpt-a");
    expect(moveModelSelection(options, "openai:gpt-a", 1)).toBe("openai:gpt-b");
  });

  it("uses the target model default when the inherited effort is unsupported", () => {
    const sol = option("openai:gpt-5.6-sol", ["low", "medium", "high"], { defaultReasoningLevel: "low" });
    const terra = option("openai:gpt-5.6-terra", ["low", "medium", "high"], { defaultReasoningLevel: "medium" });

    expect(preferredEffortIndex(sol, "off")).toBe(0);
    expect(preferredEffortIndex(terra, "off")).toBe(1);
    expect(preferredEffortIndex(terra, "high")).toBe(2);
  });

  it("synchronizes an open effort phase with authoritative metadata or backs out", () => {
    const stale = option("openai:gpt-5.6-sol", ["low", "medium"]);
    const fresh = option("openai:gpt-5.6-sol", ["medium", "high"], { label: "GPT-5.6-Sol" });
    const phase = { kind: "effort" as const, model: stale, selectedIndex: 1 };

    expect(reconcileModelPickerPhase(phase, [fresh], "low")).toEqual({
      kind: "effort",
      model: fresh,
      selectedIndex: 0,
    });
    expect(reconcileModelPickerPhase(phase, [{ ...fresh, available: false }], "low")).toEqual({ kind: "model" });
  });

  it("reports refresh and partial fallback states without hiding usable models", () => {
    const providers = [
      provider({ id: "openai", name: "OpenAI" }),
      provider({ id: "deepseek", name: "DeepSeek" }),
    ];
    const pending = new Map<string, ModelProviderDiscoveryState>([["openai", {
      status: "pending",
      models: [],
      authoritative: false,
    }]]);
    expect(formatModelDiscoveryStatus(providers, pending)).toEqual({
      text: "Refreshing model catalog…",
      hasError: false,
    });

    const failed = new Map<string, ModelProviderDiscoveryState>([
      ["openai", { status: "complete", models: [], source: "fallback", authoritative: false, error: "offline" }],
      ["deepseek", { status: "complete", models: [], source: "static", authoritative: true }],
    ]);
    expect(formatModelDiscoveryStatus(providers, failed)).toEqual({
      text: "Showing fallback models for OpenAI · Ctrl+R retry",
      hasError: true,
    });
  });

  it("normalizes raw arrow sequences for picker navigation", () => {
    expect(resolvePickerKeyAction("", { upArrow: true })).toBe("up");
    expect(resolvePickerKeyAction("\x1b[A", {})).toBe("up");
    expect(resolvePickerKeyAction("[B", {})).toBe("down");
    expect(resolvePickerKeyAction("\x1b[1;5A", {})).toBe("up");
    expect(resolvePickerKeyAction("OB", {})).toBe("down");
  });

  it("acts on the leading key of a batched input chunk instead of swallowing it", () => {
    // Slow ptys (web-terminal bridges, SSH, paste) deliver several keys as
    // ONE input event with no key flags set — the theme picker's Enter used
    // to die on exactly this.
    expect(resolvePickerKeyAction("\r/quit\r", {})).toBe("enter");
    expect(resolvePickerKeyAction("\n", {})).toBe("enter");
    expect(resolvePickerKeyAction("\x1b[B\x1b[B", {})).toBe("down");
    expect(resolvePickerKeyAction("\x1b[A\r", {})).toBe("up");
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
    expect(modelPickerBodyRows(20)).toBe(6);
    expect(modelPickerBodyRows(16)).toBe(2);
    expect(modelPickerBodyRows(8)).toBe(1);
  });

  it("keys recent dependencies by content instead of array identity", () => {
    expect(modelPickerRecentKey(["openai:gpt-a", "openai:gpt-b"]))
      .toBe(modelPickerRecentKey(["openai:gpt-a", "openai:gpt-b"]));
    expect(modelPickerRecentKey(["openai:gpt-a"]))
      .not.toBe(modelPickerRecentKey(["openai:gpt-b"]));
    expect(modelPickerRecentKey(["a", "b", "c", "d", "e", "ignored"]))
      .not.toBe(modelPickerRecentKey(["a", "b", "c", "d", "e", "different"]));
  });

  it("builds labeled display groups without duplicating model rows", () => {
    const current = option("openai:gpt-5.6-sol", ["low"], { group: "Current" });
    const terra = option("openai:gpt-5.6-terra", ["low"], { group: "Current" });
    const recent = option("openai:gpt-5.5", ["low"], { group: "Recent" });
    const items = buildModelPickerDisplayItems([current, terra, recent]);

    expect(items.map((item) => item.kind === "header" ? `header:${item.label}` : item.option.id)).toEqual([
      "header:Current",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
      "header:Recent",
      "openai:gpt-5.5",
    ]);
  });

  it("keeps a pending model visible in a one-row viewport instead of its header", () => {
    const pending = option("openai:gpt-pending", [], {
      group: "Current",
      available: false,
      pending: true,
    });
    const items = buildModelPickerDisplayItems([pending]);
    const selectedId = resolveSelectedModelId([pending], pending.id);
    const anchor = resolveModelPickerDisplayIndex(items, selectedId);
    const start = pickerWindowStart(anchor, items.length, 1);
    const visible = items.slice(start, start + 1);

    expect(selectedId).toBeUndefined();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ kind: "model", key: pending.id });
  });

  it("ranks exact, prefix, and substring search matches", () => {
    const contains = option("openai:contains", ["low"], { label: "My Terra Proxy" });
    const prefix = option("openai:prefix", ["low"], { label: "Terra Preview" });
    const exact = option("openai:exact", ["low"], { label: "Terra" });

    expect(filterAndRankModelPickerOptions([contains, prefix, exact], "terra").map((item) => item.id)).toEqual([
      "openai:exact",
      "openai:prefix",
      "openai:contains",
    ]);
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

  it("shows binary thinking toggles as on/off, leaving graded models as effort", () => {
    // MiniMax: the model row reads as a toggle, and the effort picker rows show on/off.
    const miniMaxRow = formatModelPickerRow(
      { id: "MiniMax-M3", label: "MiniMax M3", providerBadge: "minimax", reasoningLevels: ["off", "medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(miniMaxRow).toContain("thinking on/off");
    expect(miniMaxRow).not.toContain("medium");

    expect(formatEffortPickerRow("medium", { selected: true, width: 40, asToggle: true })).toContain("> on");
    expect(formatEffortPickerRow("off", { selected: false, width: 40, asToggle: true })).toContain("off");

    // Kimi K2.6 supports a real thinking on/off switch, not medium effort.
    const kimiRow = formatModelPickerRow(
      { id: "kimi-for-coding:kimi-k2.6", label: "Kimi K2.6", providerBadge: "Kimi for Coding", reasoningLevels: ["off", "medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(kimiRow).toContain("thinking on/off");
    expect(kimiRow).not.toContain("medium");

    // A graded model (e.g. GLM toggle reuses off/medium, but isn't MiniMax) keeps level labels.
    const glmRow = formatModelPickerRow(
      { id: "glm-5.1", label: "GLM-5.1", providerBadge: "zhipuai", reasoningLevels: ["off", "medium"] },
      { selected: false, current: false, width: 56 },
    );
    expect(glmRow).toContain("off/medium");
  });

  it("shows thinking-only models as on, never a placeholder grade", () => {
    // kimi-k2.7-code: thinking can't be disabled and has no grades; the internal
    // "medium" placeholder level must not leak into the picker.
    expect(formatReasoningLevelsLabel(["medium"])).toBe("on");
    const kimiRow = formatModelPickerRow(
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", providerBadge: "kimi-for-coding", reasoningLevels: ["medium"] },
      { selected: false, current: false, width: 80 },
    );
    expect(kimiRow).toContain("on");
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

function model(
  id: string,
  reasoningLevels: ThinkingLevel[],
  defaultReasoningLevel?: ThinkingLevel,
): ModelInfo {
  return {
    id,
    name: id,
    providerId: "openai",
    reasoningLevels,
    defaultReasoningLevel,
  };
}

function option(
  id: string,
  reasoningLevels: ThinkingLevel[],
  overrides: Partial<ModelPickerOption> = {},
): ModelPickerOption {
  return {
    id,
    label: id,
    group: "OpenAI",
    providerBadge: "OpenAI",
    reasoningLevels,
    available: true,
    pending: false,
    ...overrides,
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
