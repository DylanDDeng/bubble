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
  accent: string;
  border: string;
  borderActive: string;
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
  code: string;
  traceAction: string;
  traceCount: string;
  traceDetail: string;
  traceCommand: string;
  tracePending: string;

  // User message surface
  userMessageBorder: string;
  userMessageBg: string;
  userMessageText: string;
  userRail: string;

  // Diff
  diffAdd: string;
  diffRemove: string;
  diffAddFg: string;
  diffRemoveFg: string;
}

export const darkTheme: Theme = {
  user: "green",
  agent: "blue",
  error: "red",
  warning: "yellow",
  success: "green",

  accent: "cyan",
  border: "gray",
  borderActive: "cyan",
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
  code: "yellow",
  traceAction: "#E89A6B",
  traceCount: "#c9c1bd",
  traceDetail: "gray",
  traceCommand: "#59BCE8",
  tracePending: "yellow",

  userMessageBorder: "#8A7FC6",
  userMessageBg: "#2a2a34",
  userMessageText: "#f3f3f7",
  userRail: "#8A7FC6",

  diffAdd: "#1a3d1a",
  diffRemove: "#3d1a1a",
  diffAddFg: "#9CDCFE",
  diffRemoveFg: "#F48771",
};

/**
 * Light palette. Two ground rules drove the color choices:
 *   1. Named ANSI colors that render OK on both backgrounds (red/green/blue)
 *      are kept by name so the user's terminal palette overrides remain
 *      effective.
 *   2. Specific hex values are used wherever the dark palette assumed a dark
 *      background (notably accent/code/trace colors and message bubbles).
 *      Each hex was picked to clear WCAG AA contrast (4.5:1) against a near-
 *      white background (#fafafa) or, when applicable, against the explicit
 *      surface color in the same palette (e.g. diffAddFg vs diffAdd).
 */
export const lightTheme: Theme = {
  user: "green",
  agent: "blue",
  error: "red",
  warning: "#9A6500", // ANSI yellow is invisible on white — go to dark amber.
  success: "green",

  accent: "#0E5A85", // dark teal — replaces "cyan" which washes out on white.
  border: "gray",
  borderActive: "#0E5A85",
  inputBorder: "#6B5FB8",
  inputBorderDisabled: "#c5c3d0",
  inputBg: "#eeeef6",
  inputBgDisabled: "#e2e2ec",
  inputText: "#1c1c24",
  inputPlaceholder: "#7a7886",
  muted: "gray",
  dim: "gray",

  thinking: "magenta",
  thinkingDim: "gray",
  toolName: "#0E5A85",
  toolResult: "gray",
  toolError: "red",
  toolPending: "#9A6500",
  code: "#9A6500",
  traceAction: "#B85A20",
  traceCount: "#5a5a5a",
  traceDetail: "gray",
  traceCommand: "#1A5FA0",
  tracePending: "#9A6500",

  userMessageBorder: "#6B5FB8",
  userMessageBg: "#e8e6f4",
  userMessageText: "#1c1c24",
  userRail: "#6B5FB8",

  diffAdd: "#d4f4d4",
  diffRemove: "#f4d4d4",
  diffAddFg: "#1c1c24",
  diffRemoveFg: "#1c1c24",
};

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
