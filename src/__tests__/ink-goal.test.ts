import { describe, expect, it } from "vitest";
import { INK_LOCAL_SLASH_COMMANDS } from "../tui-ink/app.js";
import { createInkAppElement } from "../tui-ink/run.js";
import { GoalStore } from "../goal/store.js";

describe("Ink goal command integration", () => {
  it("exposes /goal as a local Ink slash command", () => {
    expect(INK_LOCAL_SLASH_COMMANDS).toContainEqual({
      name: "goal",
      description: "Set/manage an autonomous goal (/goal <objective>|clear|pause|resume|edit)",
    });
  });

  it("exposes local display commands in the Ink slash palette", () => {
    expect(INK_LOCAL_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "thinking",
      "goal",
    ]);
  });

  it("passes the shared goal store from the Ink runner into the App", () => {
    const goalStore = new GoalStore();
    const element = createInkAppElement(
      {} as any,
      { cwd: "/tmp/project" } as any,
      { goalStore },
      () => {},
    );

    expect((element.props as any).goalStore).toBe(goalStore);
  });
});
