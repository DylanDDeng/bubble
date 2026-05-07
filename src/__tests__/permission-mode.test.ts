import { describe, expect, it } from "vitest";
import { getNextPermissionMode, PERMISSION_MODE_INFO } from "../permission/mode.js";

describe("getNextPermissionMode", () => {
  it("cycles the interactive keybind through build, plan, and bypass", () => {
    expect(getNextPermissionMode("default")).toBe("plan");
    expect(getNextPermissionMode("plan")).toBe("bypassPermissions");
    expect(getNextPermissionMode("bypassPermissions")).toBe("default");
  });

  it("exposes display info for every permission mode", () => {
    for (const mode of ["default", "plan", "bypassPermissions"] as const) {
      const info = PERMISSION_MODE_INFO[mode];
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.shortTitle.length).toBeGreaterThan(0);
      expect(info.color.length).toBeGreaterThan(0);
    }
  });
});
