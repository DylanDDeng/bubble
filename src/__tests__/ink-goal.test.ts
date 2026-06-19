import { describe, expect, it } from "vitest";
import { INK_LOCAL_SLASH_COMMANDS } from "../tui-ink/app.js";

describe("Ink goal command integration", () => {
  it("exposes /goal as a local Ink slash command", () => {
    expect(INK_LOCAL_SLASH_COMMANDS).toContainEqual({
      name: "goal",
      description: "Set/manage an autonomous goal (/goal <objective>|clear|pause|resume|edit)",
    });
  });

  it("exposes OpenTUI-local display commands in the Ink slash palette", () => {
    expect(INK_LOCAL_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "thinking",
      "toggle-thinking",
      "goal",
      "trace",
      "verbose",
      "debug",
      "write-previews",
    ]);
  });
});
