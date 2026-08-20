import chalk from "chalk";
import { stripTerminalSequences } from "@bubblebrain-ai/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWelcomeBanner } from "../tui/components/welcome.js";

let previousChalkLevel = chalk.level;

beforeEach(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = previousChalkLevel;
});

describe("welcome banner color hierarchy", () => {
  it("renders the frame as muted gray without changing the title accent", () => {
    const rows = renderWelcomeBanner({
      cwd: "~/project",
      session: "session.jsonl",
      model: "glm-5.3",
      provider: "zhipuai-coding-plan",
      thinking: "max",
    }, 100);

    expect(rows[0]).toContain("\x1b[2m");
    expect(rows[0]).not.toContain("\x1b[36m");
    expect(rows.at(-2)).toContain("\x1b[2m");
    expect(stripTerminalSequences(rows.join("\n"))).toContain("Welcome to Bubble!");
  });
});
