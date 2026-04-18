import { describe, expect, it } from "vitest";
import { getNextPermissionMode, PERMISSION_MODE_INFO } from "../permission/mode.js";

describe("getNextPermissionMode", () => {
  it("cycles default → acceptEdits → plan → default by default", () => {
    expect(getNextPermissionMode("default")).toBe("acceptEdits");
    expect(getNextPermissionMode("acceptEdits")).toBe("plan");
    expect(getNextPermissionMode("plan")).toBe("default");
  });

  it("includes bypassPermissions in the cycle when bypassEnabled is true", () => {
    expect(getNextPermissionMode("default", { bypassEnabled: true })).toBe("acceptEdits");
    expect(getNextPermissionMode("acceptEdits", { bypassEnabled: true })).toBe("plan");
    expect(getNextPermissionMode("plan", { bypassEnabled: true })).toBe("bypassPermissions");
    expect(getNextPermissionMode("bypassPermissions", { bypassEnabled: true })).toBe("default");
  });

  it("falls back to default when the current mode is not in the cycle (e.g. dontAsk)", () => {
    expect(getNextPermissionMode("dontAsk")).toBe("default");
    expect(getNextPermissionMode("bypassPermissions")).toBe("default"); // bypass not enabled
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
