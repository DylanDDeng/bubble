import { homedir, tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBubbleHomeInfo } from "../bubble-home.js";
import { ModelConfig } from "../model-config.js";

describe("bubble home", () => {
  const originalBubbleHome = process.env.BUBBLE_HOME;
  const originalBubbleDev = process.env.BUBBLE_DEV;

  afterEach(() => {
    if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = originalBubbleHome;
    if (originalBubbleDev === undefined) delete process.env.BUBBLE_DEV;
    else process.env.BUBBLE_DEV = originalBubbleDev;
  });

  it("defaults to production home", () => {
    delete process.env.BUBBLE_HOME;
    delete process.env.BUBBLE_DEV;

    expect(getBubbleHomeInfo()).toEqual({
      home: join(homedir(), ".bubble"),
      environment: "production",
    });
  });

  it("uses dev home when BUBBLE_DEV is enabled", () => {
    delete process.env.BUBBLE_HOME;
    process.env.BUBBLE_DEV = "1";

    expect(getBubbleHomeInfo()).toEqual({
      home: join(homedir(), ".bubble-dev"),
      environment: "dev",
    });
  });

  it("lets BUBBLE_HOME override dev mode", () => {
    process.env.BUBBLE_HOME = "/tmp/custom-bubble-home";
    process.env.BUBBLE_DEV = "1";

    expect(getBubbleHomeInfo()).toEqual({
      home: "/tmp/custom-bubble-home",
      environment: "custom",
    });
  });

  it("loads model configuration only from the selected Bubble home", () => {
    const root = mkdtempSync(join(tmpdir(), "bubble-model-config-test-"));
    try {
      const userHome = join(root, "user-test");
      const qaHome = join(root, "qa");
      mkdirSync(userHome);
      mkdirSync(qaHome);
      writeFileSync(join(userHome, "models.json"), JSON.stringify({
        providers: { fixture: { models: [{ id: "user-model" }] } },
      }));
      process.env.BUBBLE_HOME = userHome;
      const userConfig = new ModelConfig();
      expect(userConfig.getPath()).toBe(join(userHome, "models.json"));
      expect(userConfig.getCustomModels("fixture").map(m => m.id)).toEqual(["user-model"]);

      process.env.BUBBLE_HOME = qaHome;
      expect(new ModelConfig().getCustomModels("fixture")).toEqual([]);
      writeFileSync(join(qaHome, "models.json"), JSON.stringify({
        providers: { fixture: { models: [{ id: "qa-model" }] } },
      }));
      expect(new ModelConfig().getCustomModels("fixture").map(m => m.id)).toEqual(["qa-model"]);
      expect(userConfig.getPath(), 'existing instances keep their home').toBe(join(userHome, "models.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
