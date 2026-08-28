/**
 * Renderer-neutral theme tokens shared by the terminal UI surfaces.
 */
export type ResolvedTheme = "light" | "dark";
export type ThemeMode = "auto" | ResolvedTheme;
export interface Theme {
  // Actors
  user: string;
  agent: string;
  error: string;
  warning: string;
  success: string;

  // UI chrome
  /**
   * Painted canvas color. `undefined` means "do not paint" — the terminal's
   * own background shows through, so the app never fights the user's terminal
   * palette (e.g. forcing pure black inside a soft-dark terminal). Users can
   * still force a painted canvas via `theme.overrides.background` in config.
   */
  background: string | undefined;
  accent: string;
  /** Welcome banner border. */
  bannerBorder: string;
  /** Welcome banner logo/title gradient endpoints (top→bottom, left→right). */
  bannerGradientFrom: string;
  bannerGradientTo: string;
  border: string;
  borderActive: string;
  backgroundPanel: string;
  backgroundElement: string;
  inputBorder: string;
  inputBorderDisabled: string;
  inputBg: string;
  inputBgDisabled: string;
  inputText: string;
  inputPlaceholder: string;
  muted: string;
  dim: string;

  // Content
  thinking: string;
  thinkingDim: string;
  toolName: string;
  toolResult: string;
  toolError: string;
  toolPending: string;
  /** Markdown inline `code` spans. */
  inlineCode: string;
  traceAction: string;
  traceCount: string;
  traceDetail: string;
  traceCommand: string;
  tracePending: string;
  /** Neutral painted surfaces for pointer-hovered / selected tool traces. */
  traceHoverBg: string;
  traceSelectedBg: string;

  // User message surface
  userMessageBorder: string;
  userMessageBg: string;
  userMessageText: string;

  // Diff
  /** Painted band backgrounds for diff lines inside user-message cards. */
  diffAdd: string;
  diffRemove: string;
  /** Foregrounds for +/- diff lines rendered without a painted background. */
  diffAddFg: string;
  diffRemoveFg: string;
}
export const darkTheme: Theme = {
  user: "green",
  agent: "blue",
  error: "red",
  warning: "yellow",
  success: "green",

  background: undefined,
  accent: "cyan",
  bannerBorder: "#38bdf8",
  bannerGradientFrom: "#67e8f9",
  bannerGradientTo: "#a78bfa",
  border: "gray",
  borderActive: "cyan",
  backgroundPanel: "#141414",
  backgroundElement: "#1c1c24",
  inputBorder: "#8A7FC6",
  inputBorderDisabled: "#4a4754",
  inputBg: "#1c1c24",
  inputBgDisabled: "#161620",
  inputText: "#f3f3f7",
  inputPlaceholder: "#6c6a78",
  muted: "gray",
  dim: "gray",

  thinking: "magenta",
  thinkingDim: "gray",
  toolName: "cyan",
  toolResult: "gray",
  toolError: "red",
  toolPending: "yellow",
  inlineCode: "#a78bfa",
  traceAction: "#E89A6B",
  traceCount: "#c9c1bd",
  traceDetail: "gray",
  traceCommand: "#59BCE8",
  tracePending: "yellow",
  traceHoverBg: "#232323",
  traceSelectedBg: "#2B2B2B",

  userMessageBorder: "#8A7FC6",
  userMessageBg: "#2A2A2A",
  userMessageText: "#f3f3f7",

  diffAdd: "#1a3d1a",
  diffRemove: "#3d1a1a",
  diffAddFg: "green",
  diffRemoveFg: "red",
};
export const lightTheme: Theme = {
  user: "#356FD2",
  agent: "#171717",
  error: "#B62633",
  warning: "#8B4A00",
  success: "#2F7D4A",

  background: undefined,
  accent: "#8B4A00",
  bannerBorder: "#356FD2",
  bannerGradientFrom: "#0E7490",
  bannerGradientTo: "#6D28D9",
  border: "#B9BDB8",
  borderActive: "#356FD2",
  backgroundPanel: "#F6F6F3",
  backgroundElement: "#ECEDEA",
  inputBorder: "#356FD2",
  inputBorderDisabled: "#D7DAD4",
  inputBg: "#F1F3F0",
  inputBgDisabled: "#F6F6F3",
  inputText: "#171717",
  inputPlaceholder: "#6F7377",
  muted: "#6F7377",
  dim: "#8B9094",

  thinking: "#5F666D",
  thinkingDim: "#8B9094",
  toolName: "#495057",
  toolResult: "#171717",
  toolError: "#B62633",
  toolPending: "#8B4A00",
  inlineCode: "#6D28D9",
  traceAction: "#8B4A00",
  traceCount: "#6F7377",
  traceDetail: "#8B9094",
  traceCommand: "#257E8A",
  tracePending: "#8B4A00",
  traceHoverBg: "#E8E8E5",
  traceSelectedBg: "#DDDFDB",

  userMessageBorder: "#356FD2",
  userMessageBg: "#F1F3F0",
  userMessageText: "#234B93",

  diffAdd: "#D7E8D8",
  diffRemove: "#F7DADC",
  diffAddFg: "#2F7D4A",
  diffRemoveFg: "#B62633",
};
const paintedCanvas: Record<ResolvedTheme, string> = {
  dark: "#0A0A0A",
  light: "#FCFCFA",
};

export function canvasBackgroundFor(
  mode: ThemeMode,
  resolved: ResolvedTheme,
  terminalTheme: ResolvedTheme,
): string | undefined {
  if (mode === "auto" || resolved === terminalTheme) return undefined;
  return paintedCanvas[resolved];
}

/** Build a palette from one of the shipped themes plus user overrides. */
export function paletteFor(
  resolved: ResolvedTheme,
  overrides?: Record<string, string>,
): Theme {
  const base = resolved === "light" ? lightTheme : darkTheme;
  if (!overrides) return { ...base };

  const palette = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || !(key in base)) continue;
    (palette as unknown as Record<string, string | undefined>)[key] = value;
  }
  return palette;
}

/** Resolve the complete live palette used by an interactive TUI instance. */
export function resolveThemePalette(
  mode: ThemeMode,
  terminalTheme: ResolvedTheme,
  overrides?: Record<string, string>,
): { resolved: ResolvedTheme; palette: Theme } {
  const resolved = mode === "auto" ? terminalTheme : mode;
  const palette = paletteFor(resolved, overrides);
  if (palette.background === undefined) {
    palette.background = canvasBackgroundFor(mode, resolved, terminalTheme);
  }
  return { resolved, palette };
}
