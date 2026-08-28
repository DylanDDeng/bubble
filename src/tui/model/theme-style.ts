import chalk from "chalk";

type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "grey";

const NAMED_COLORS = new Set<NamedColor>([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
]);

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
}

/** Apply a configured foreground without letting a malformed override crash rendering. */
export function themeForeground(color: string | undefined, text: string): string {
  if (!color) return text;
  if (isHexColor(color)) return chalk.hex(color)(text);
  const normalized = color.toLowerCase() as NamedColor;
  if (NAMED_COLORS.has(normalized)) return chalk[normalized](text);
  return text;
}

/** Apply a configured background without letting a malformed override crash rendering. */
export function themeBackground(color: string | undefined, text: string): string {
  if (!color) return text;
  if (isHexColor(color)) return chalk.bgHex(color)(text);
  const normalized = color.toLowerCase() as NamedColor;
  if (!NAMED_COLORS.has(normalized)) return text;
  switch (normalized) {
    case "black": return chalk.bgBlack(text);
    case "red": return chalk.bgRed(text);
    case "green": return chalk.bgGreen(text);
    case "yellow": return chalk.bgYellow(text);
    case "blue": return chalk.bgBlue(text);
    case "magenta": return chalk.bgMagenta(text);
    case "cyan": return chalk.bgCyan(text);
    case "white": return chalk.bgWhite(text);
    case "gray":
    case "grey": return chalk.bgGray(text);
  }
}

export function themeDim(color: string | undefined, text: string): string {
  return chalk.dim(themeForeground(color, text));
}

/** ANSI pair used by the alternate-screen renderer to paint every cell. */
export function themeBackgroundCodes(
  color: string | undefined,
): { open: string; close: string } | undefined {
  if (!color) return undefined;
  if (isHexColor(color)) {
    const expanded = color.length === 4
      ? color.slice(1).split("").map((part) => part + part).join("")
      : color.slice(1);
    const channels = expanded.match(/../g)?.map((part) => Number.parseInt(part, 16));
    if (!channels || channels.length !== 3) return undefined;
    return { open: `\x1b[48;2;${channels.join(";")}m`, close: "\x1b[49m" };
  }
  const normalized = color.toLowerCase() as NamedColor;
  if (!NAMED_COLORS.has(normalized)) return undefined;
  const code = normalized === "black" ? 40
    : normalized === "red" ? 41
      : normalized === "green" ? 42
        : normalized === "yellow" ? 43
          : normalized === "blue" ? 44
            : normalized === "magenta" ? 45
              : normalized === "cyan" ? 46
                : normalized === "white" ? 47
                  : 100;
  return { open: `\x1b[${code}m`, close: "\x1b[49m" };
}
