import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectUsageStatsBundle, formatStatsPanelBody, formatStatsText } from "../stats/usage.js";

function tempSessionsRoot() {
  return mkdtempSync(join(tmpdir(), "bubble-stats-"));
}

function writeSession(root: string, name: string, entries: unknown[]) {
  const dir = join(root, "_tmp_project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function ts(date: string) {
  return new Date(`${date}T12:00:00`).getTime();
}

describe("usage stats", () => {
  it("aggregates model usage for 7 day and 30 day ranges", () => {
    const root = tempSessionsRoot();
    writeSession(root, "usage", [
      {
        id: "metadata",
        type: "metadata",
        metadata: { model: "openai-codex:gpt-5.5" },
        timestamp: ts("2026-05-01"),
      },
      {
        id: "1",
        type: "assistant_message",
        timestamp: ts("2026-05-20"),
        message: {
          role: "assistant",
          content: "older",
          model: "openai-codex:gpt-5.5",
          providerId: "openai-codex",
          modelId: "gpt-5.5",
          usage: { promptTokens: 2000, completionTokens: 500 },
        },
      },
      {
        id: "2",
        type: "assistant_message",
        timestamp: ts("2026-05-28"),
        message: {
          role: "assistant",
          content: "recent",
          model: "deepseek:deepseek-v4-pro",
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          usage: {
            promptTokens: 1_000_000,
            completionTokens: 100_000,
            promptCacheHitTokens: 100_000,
            promptCacheMissTokens: 900_000,
          },
        },
      },
    ]);

    const bundle = collectUsageStatsBundle({
      now: new Date("2026-05-28T18:00:00"),
      sessionsRoot: root,
    });

    expect(bundle.ranges["7d"].models.map((model) => model.model)).toEqual(["deepseek:deepseek-v4-pro"]);
    expect(bundle.ranges["7d"].totalTokens).toBe(1_100_000);
    expect(bundle.ranges["30d"].models.map((model) => model.model)).toEqual([
      "deepseek:deepseek-v4-pro",
      "openai-codex:gpt-5.5",
    ]);
    expect(bundle.ranges["30d"].totalTokens).toBe(1_102_500);
    expect(bundle.ranges["30d"].trackedCost).toBeGreaterThan(0);
  });

  it("counts active legacy sessions without inventing token usage", () => {
    const root = tempSessionsRoot();
    writeSession(root, "legacy", [
      {
        id: "metadata",
        type: "metadata",
        metadata: { model: "openai-codex:gpt-5.5" },
        timestamp: ts("2026-05-28"),
      },
      {
        id: "1",
        type: "user_message",
        timestamp: ts("2026-05-28"),
        message: { role: "user", content: "hello" },
      },
      {
        id: "2",
        type: "assistant_message",
        timestamp: ts("2026-05-28"),
        message: { role: "assistant", content: "hi" },
      },
    ]);

    const stats = collectUsageStatsBundle({
      now: new Date("2026-05-28T18:00:00"),
      sessionsRoot: root,
    }).ranges["7d"];

    expect(stats.activeDays).toBe(1);
    expect(stats.sessionsScanned).toBe(1);
    expect(stats.sessionsWithoutTokenData).toBe(1);
    expect(stats.models).toEqual([]);
    expect(stats.totalTokens).toBe(0);
  });

  it("formats heatmap, bars, and optional tracked cost", () => {
    const root = tempSessionsRoot();
    writeSession(root, "usage", [
      {
        id: "1",
        type: "assistant_message",
        timestamp: ts("2026-05-28"),
        message: {
          role: "assistant",
          content: "recent",
          model: "deepseek:deepseek-v4-pro",
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          usage: { promptTokens: 1000, completionTokens: 500 },
        },
      },
    ]);

    const text = formatStatsText(collectUsageStatsBundle({
      now: new Date("2026-05-28T18:00:00"),
      sessionsRoot: root,
    }));

    expect(text).toContain("Bubble Stats · Last 30 days");
    expect(text).toContain("Activity");
    expect(text).toContain("Model usage");
    expect(text).toContain("@");
    expect(text).toContain("Less . o O @ More");
    expect(text).toContain("Tracked cost");
    expect(text).not.toContain("cost unavailable");
  });

  it("keeps panel rows within the requested body width", () => {
    const root = tempSessionsRoot();
    writeSession(root, "usage", [
      {
        id: "1",
        type: "assistant_message",
        timestamp: ts("2026-05-28"),
        message: {
          role: "assistant",
          content: "recent",
          model: "deepseek:deepseek-v4-pro",
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          usage: { promptTokens: 129_000, completionTokens: 200 },
        },
      },
    ]);

    const stats = collectUsageStatsBundle({
      now: new Date("2026-05-28T18:00:00"),
      sessionsRoot: root,
    }).ranges["30d"];

    const width = 48;
    const lines = formatStatsPanelBody(stats, width).split("\n");
    expect(lines.every((line) => line.length <= width)).toBe(true);
  });

  it("omits cost when no model has pricing", () => {
    const root = tempSessionsRoot();
    writeSession(root, "usage", [
      {
        id: "1",
        type: "assistant_message",
        timestamp: ts("2026-05-28"),
        message: {
          role: "assistant",
          content: "recent",
          model: "openai-codex:gpt-5.5",
          providerId: "openai-codex",
          modelId: "gpt-5.5",
          usage: { promptTokens: 1000, completionTokens: 500 },
        },
      },
    ]);

    const text = formatStatsText(collectUsageStatsBundle({
      now: new Date("2026-05-28T18:00:00"),
      sessionsRoot: root,
    }));

    expect(text).not.toContain("Tracked cost");
    expect(text).not.toContain("cost unavailable");
  });
});
