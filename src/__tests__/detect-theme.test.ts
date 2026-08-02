import { describe, expect, it } from "vitest";
import { parseColorFgBg, themeFromMacOsAppearance } from "../tui/detect-theme.js";

describe("terminal theme detection helpers", () => {
  it("maps macOS dark appearance output to dark", () => {
    expect(themeFromMacOsAppearance("Dark\n")).toBe("dark");
  });

  it("maps missing macOS appearance output to light", () => {
    expect(themeFromMacOsAppearance(null)).toBe("light");
    expect(themeFromMacOsAppearance("")).toBe("light");
  });

  it("maps COLORFGBG background index to a theme", () => {
    expect(parseColorFgBg("15;0")).toBe("dark");
    expect(parseColorFgBg("0;15")).toBe("light");
    expect(parseColorFgBg("12;8;7")).toBe("light");
  });

  it("rejects unparseable COLORFGBG values", () => {
    expect(parseColorFgBg(undefined)).toBeNull();
    expect(parseColorFgBg("")).toBeNull();
    expect(parseColorFgBg("15;default")).toBeNull();
    expect(parseColorFgBg("15;42")).toBeNull();
  });
});
