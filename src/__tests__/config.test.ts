import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { UserConfig } from "../config.js";

describe("UserConfig", () => {
  const root = join(tmpdir(), `bubble-config-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const originalBubbleHome = process.env.BUBBLE_HOME;

  afterEach(() => {
    process.env.BUBBLE_HOME = originalBubbleHome;
  });

  it("falls back to the most recent model when defaultModel is missing", () => {
    process.env.BUBBLE_HOME = root;
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        recentModels: ["openai:gpt-5.4"],
      }, null, 2),
    );

    const config = new UserConfig();
    expect(config.getDefaultModel()).toBe("openai:gpt-5.4");
  });

  it("updates defaultModel when pushing a recent model", () => {
    process.env.BUBBLE_HOME = root;
    writeFileSync(join(root, "config.json"), JSON.stringify({}, null, 2));

    const config = new UserConfig();
    config.pushRecentModel("openai:gpt-5.4");

    expect(config.getDefaultModel()).toBe("openai:gpt-5.4");
    expect(config.getRecentModels()[0]).toBe("openai:gpt-5.4");
  });

  it("persists and restores default thinking level", () => {
    process.env.BUBBLE_HOME = root;
    writeFileSync(join(root, "config.json"), JSON.stringify({}, null, 2));

    const config = new UserConfig();
    config.setDefaultThinkingLevel("high");

    const restored = new UserConfig();
    expect(restored.getDefaultThinkingLevel()).toBe("high");
  });
});
