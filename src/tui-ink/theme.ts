/**
 * Color themes for the TUI.
 *
 * Two base palettes are shipped: `darkTheme` for dark terminal backgrounds and
 * `lightTheme` for light ones. The shape is identical so consumers depend on
 * `Theme` rather than either palette directly. Active palette is provided
 * through `ThemeContext` so components re-render automatically when the
 * user switches via `/theme` at runtime.
 */

import { createContext, useContext } from "react";

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

  userMessageBorder: "#8A7FC6",
  userMessageBg: "#2a2a34",
  userMessageText: "#f3f3f7",

  diffAdd: "#1a3d1a",
  diffRemove: "#3d1a1a",
  diffAddFg: "green",
  diffRemoveFg: "red",
};

/**
 * Light palette tuned for paper-neutral surfaces, blue focus/user rails, warm
 * command accent, and semantic tool colors with readable contrast on a light
 * terminal background.
 */
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

  userMessageBorder: "#356FD2",
  userMessageBg: "#F1F3F0",
  userMessageText: "#234B93",

  diffAdd: "#D7E8D8",
  diffRemove: "#F7DADC",
  diffAddFg: "#2F7D4A",
  diffRemoveFg: "#B62633",
};

/** Canvas colors painted only when a forced theme mismatches the terminal. */
const paintedCanvas: Record<ResolvedTheme, string> = {
  dark: "#0A0A0A",
  light: "#FCFCFA",
};

/**
 * Decide whether the canvas needs painting. Auto mode always inherits the
 * terminal's own background, and so does a forced theme that matches the
 * detected terminal. A forced theme that mismatches (e.g. `/theme light`
 * inside a dark terminal) paints its canvas, because its foregrounds are
 * tuned for the opposite background and would otherwise be unreadable.
 */
export function canvasBackgroundFor(
  mode: ThemeMode,
  resolved: ResolvedTheme,
  terminalTheme: ResolvedTheme,
): string | undefined {
  if (mode === "auto" || resolved === terminalTheme) return undefined;
  return paintedCanvas[resolved];
}

const ThemeContext = createContext<Theme>(darkTheme);
export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Build the active palette given a resolved mode and optional overrides. */
export function paletteFor(
  mode: ResolvedTheme,
  overrides?: Record<string, string>,
): Theme {
  const base = mode === "light" ? lightTheme : darkTheme;
  if (!overrides) return base;
  const filtered: Partial<Theme> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" && key in base) {
      (filtered as Record<string, string>)[key] = value;
    }
  }
  return { ...base, ...filtered };
}
