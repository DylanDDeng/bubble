import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBubbleHomeInfo } from "../bubble-home.js";

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
});
