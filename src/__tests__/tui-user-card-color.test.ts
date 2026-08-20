import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderUserCard } from "../tui/components/transcript.js";
import { darkTheme } from "../tui/model/theme.js";

let previousChalkLevel = chalk.level;

beforeEach(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = previousChalkLevel;
});

describe("user message card color hierarchy", () => {
  it("uses the neutral charcoal surface instead of the former blue background", () => {
    const rows = renderUserCard("hello", { columns: 40 });

    expect(darkTheme.userMessageBg).toBe("#2A2A2A");
    expect(rows.every((row) => row.includes("\x1b[48;2;42;42;42m"))).toBe(true);
    expect(rows.join("\n")).not.toContain("\x1b[48;2;34;53;74m");
  });
});
