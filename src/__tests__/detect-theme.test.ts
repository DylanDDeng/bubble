import { describe, expect, it } from "vitest";
import { themeFromMacOsAppearance } from "../tui/detect-theme.js";

describe("terminal theme detection helpers", () => {
  it("maps macOS dark appearance output to dark", () => {
    expect(themeFromMacOsAppearance("Dark\n")).toBe("dark");
  });

  it("maps missing macOS appearance output to light", () => {
    expect(themeFromMacOsAppearance(null)).toBe("light");
    expect(themeFromMacOsAppearance("")).toBe("light");
  });
});
