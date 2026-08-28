import {
  Input,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@bubblebrain-ai/pi-tui";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeBackground, themeDim, themeForeground } from "../model/theme-style.js";

function fillLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Inline credential phase used by /provider.
 *
 * It deliberately owns a plain masked Input instead of the main Editor so a
 * credential can never enter composer history, autocomplete, or transcript
 * state. Its geometry mirrors the model/reasoning command surface: a filled
 * context row immediately above the normal square composer frame.
 */
export class ProviderKeyInputComponent implements Component {
  constructor(
    readonly input: Input,
    private readonly providerName: string,
    private readonly getTheme: () => Theme = () => darkTheme,
  ) {}

  render(width: number): string[] {
    const theme = this.getTheme();
    const borderColor = (text: string): string => themeDim(theme.border, text);
    const surfaceBackground = (text: string): string => themeBackground(theme.backgroundPanel, text);
    const safeWidth = Math.max(1, Math.floor(width));
    const title = `  Enter API Key for ${this.providerName}`;
    const hint = " · Enter to save · Esc or empty Backspace to return";
    const surface = surfaceBackground(fillLine(`${themeForeground(theme.accent, "◆")}${title}${themeDim(theme.dim, hint)}`, safeWidth));

    if (safeWidth < 3) {
      return [surface, ...this.input.render(safeWidth)];
    }

    const innerWidth = safeWidth - 2;
    const inputLine = this.input.render(innerWidth)[0] ?? " ".repeat(innerWidth);
    const horizontal = "─".repeat(innerWidth);
    return [
      surface,
      borderColor(`┌${horizontal}┐`),
      `${borderColor("│")}${fillLine(inputLine, innerWidth)}${borderColor("│")}`,
      borderColor(`└${horizontal}┘`),
    ];
  }

  invalidate(): void {
    this.input.invalidate?.();
  }
}
