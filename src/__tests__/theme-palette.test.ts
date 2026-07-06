import { describe, expect, it } from "vitest";
import { darkTheme as inkDarkTheme, lightTheme as inkLightTheme } from "../tui-ink/theme.js";

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #rrggbb color, got ${hex}`);
  const raw = match[1]!;
  const values = [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = values.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastOnWhite(hex: string): number {
  // WCAG contrast ratio against a near-white canvas (worst case for light fg).
  return (1.0 + 0.05) / (luminance(hex) + 0.05);
}

describe("TUI theme palettes", () => {
  it("keeps the Ink light composer surface light", () => {
    expect(luminance(inkLightTheme.inputBg)).toBeGreaterThan(0.88);
    expect(luminance(inkLightTheme.inputBgDisabled)).toBeGreaterThan(0.9);
  });

  it("keeps the dark composer surface dark for true dark mode", () => {
    expect(luminance(inkDarkTheme.inputBg)).toBeLessThan(0.05);
  });

  it("keeps light-mode foreground accents readable on light terminals", () => {
    // Inline code and diff foregrounds render directly on the terminal
    // background (no painted band), so they must clear WCAG AA (4.5:1)
    // against a light canvas.
    for (const color of [
      inkLightTheme.inlineCode,
      inkLightTheme.diffAddFg,
      inkLightTheme.diffRemoveFg,
    ]) {
      expect(contrastOnWhite(color)).toBeGreaterThan(4.5);
    }
  });

  it("keeps dark-mode diff foregrounds on the terminal's own ANSI palette", () => {
    // Named ANSI colors track the user's terminal scheme instead of guessing
    // hexes, which is the point of the adaptive theme.
    expect(inkDarkTheme.diffAddFg).toBe("green");
    expect(inkDarkTheme.diffRemoveFg).toBe("red");
  });
});
