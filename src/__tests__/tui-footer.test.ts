import chalk from "chalk";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponsiveFooterComponent, renderFooterLine, renderPermissionModeBadge } from "../tui/footer.js";

const agent = {
  model: "kimi-for-coding:k3-长模型🤖",
  getContextUsageSnapshot: () => ({ usedTokens: 12_345, contextWindow: 128_000 }),
};

let previousChalkLevel = chalk.level;

beforeEach(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = previousChalkLevel;
});

describe("responsive TUI footer", () => {
  it("stays on one terminal row at every narrow width with ANSI and wide cells", () => {
    for (let width = 1; width <= 40; width += 1) {
      const line = renderFooterLine(agent, width, {
        cwd: "~/项目/终端🫧",
        extra: [chalk.yellow("queue ×12"), chalk.magenta("steer ×3 🚦")],
        mode: "bypassPermissions",
      });

      expect(line).not.toContain("\n");
      expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("renders exactly one live-width row, or no row when hidden", () => {
    let hidden = false;
    const footer = new ResponsiveFooterComponent(() => ({
      agent,
      cwd: "~/项目/终端🫧",
      extra: [chalk.yellow("queue ×12")],
      hidden,
    }));

    for (let width = 1; width <= 40; width += 1) {
      const rows = footer.render(width);
      expect(rows).toHaveLength(1);
      expect(stringWidth(rows[0]!)).toBeLessThanOrEqual(width);
    }

    hidden = true;
    expect(footer.render(20)).toEqual([]);
  });

  it("renders an active goal as a separate width-safe status row", () => {
    const footer = new ResponsiveFooterComponent(() => ({
      agent,
      cwd: "~/project",
      goalLine: "goal: active · 12 turns · 63.9K/200K tok — ship the release safely",
    }));

    for (let width = 1; width <= 80; width += 1) {
      const rows = footer.render(width);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => stringWidth(row) <= width)).toBe(true);
    }
    expect(footer.render(80)[0]).toContain("goal: active");
  });

  it("shows the legacy non-default permission badges and hides default mode", () => {
    expect(renderPermissionModeBadge("default")).toBe("");
    expect(renderPermissionModeBadge("plan")).toContain("⏸ plan on");
    expect(renderPermissionModeBadge("bypassPermissions")).toContain("⏵⏵ bypass permission on");

    const plan = renderFooterLine(agent, 100, { mode: "plan" });
    const bypass = renderFooterLine(agent, 100, { mode: "bypassPermissions" });
    expect(plan).toContain("plan on");
    expect(bypass).toContain("bypass permission on");
  });

  it("keeps the model in the same muted hierarchy as cwd and context usage", () => {
    const line = renderFooterLine(agent, 100, { cwd: "~/project" });
    expect(line).toContain(chalk.dim(agent.model));
    expect(line).toContain(chalk.dim("~/project"));
    expect(line).not.toContain(chalk.cyan(agent.model));
  });
});
