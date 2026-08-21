import chalk from "chalk";
import {
  Input,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@bubblebrain-ai/pi-tui";

const borderColor = (text: string): string => chalk.rgb(160, 160, 160).dim(text);
const surfaceBackground = (text: string): string => chalk.bgRgb(31, 31, 31)(text);

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
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const title = `  Enter API Key for ${this.providerName}`;
    const hint = " · Enter to save · Esc or empty Backspace to return";
    const surface = surfaceBackground(fillLine(`${chalk.cyan("◆")}${title}${chalk.dim(hint)}`, safeWidth));

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
