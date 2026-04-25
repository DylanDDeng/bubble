import { describe, expect, it } from "vitest";
import { getNextPermissionMode, PERMISSION_MODE_INFO } from "../permission/mode.js";

describe("getNextPermissionMode", () => {
  it("toggles the interactive keybind between build/default and plan", () => {
    expect(getNextPermissionMode("default")).toBe("plan");
    expect(getNextPermissionMode("acceptEdits")).toBe("plan");
    expect(getNextPermissionMode("plan")).toBe("default");
  });

  it("does not cycle into bypassPermissions even when bypass is enabled", () => {
    expect(getNextPermissionMode("default", { bypassEnabled: true })).toBe("plan");
    expect(getNextPermissionMode("acceptEdits", { bypassEnabled: true })).toBe("plan");
    expect(getNextPermissionMode("plan", { bypassEnabled: true })).toBe("default");
    expect(getNextPermissionMode("bypassPermissions", { bypassEnabled: true })).toBe("default");
  });

  it("falls back to default from non-interactive modes", () => {
    expect(getNextPermissionMode("dontAsk")).toBe("default");
    expect(getNextPermissionMode("bypassPermissions")).toBe("default");
  });

  it("exposes display info for every permission mode", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const) {
      const info = PERMISSION_MODE_INFO[mode];
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.shortTitle.length).toBeGreaterThan(0);
      expect(info.color.length).toBeGreaterThan(0);
    }
  });
});
