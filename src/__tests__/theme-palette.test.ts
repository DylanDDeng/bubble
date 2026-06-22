import { describe, expect, it } from "vitest";
import { shouldUseLineComposerFrame } from "../tui-ink/input-box.js";
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

describe("TUI theme palettes", () => {
  it("keeps the Ink light composer surface light and aligned with the page", () => {
    expect(inkLightTheme.inputBg).toBe(inkLightTheme.background);
    expect(luminance(inkLightTheme.inputBg)).toBeGreaterThan(0.9);
    expect(luminance(inkLightTheme.inputBgDisabled)).toBeGreaterThan(0.9);
  });

  it("keeps the dark composer surface dark for true dark mode", () => {
    expect(luminance(inkDarkTheme.inputBg)).toBeLessThan(0.05);
  });

  it("uses the compact two-line composer frame for both light and dark backgrounds", () => {
    expect(shouldUseLineComposerFrame(inkLightTheme.background)).toBe(true);
    expect(shouldUseLineComposerFrame(inkDarkTheme.background)).toBe(true);
  });
});
