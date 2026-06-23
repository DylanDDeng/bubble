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
  background: string;
  accent: string;
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

  background: "#0A0A0A",
  accent: "cyan",
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

  background: "#FCFCFA",
  accent: "#8B4A00",
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
  code: "#2F7D4A",
  traceAction: "#8B4A00",
  traceCount: "#6F7377",
  traceDetail: "#8B9094",
  traceCommand: "#257E8A",
  tracePending: "#8B4A00",

  userMessageBorder: "#356FD2",
  userMessageBg: "#F1F3F0",
  userMessageText: "#234B93",
  userRail: "#356FD2",

  diffAdd: "#D7E8D8",
  diffRemove: "#F7DADC",
  diffAddFg: "#173D2D",
  diffRemoveFg: "#5D1922",
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
