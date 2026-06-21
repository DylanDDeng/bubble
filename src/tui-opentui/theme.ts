/**
 * Theme for the OpenTUI TUI, structured after opencode's grayscale + semantic
 * accent model. Bubble keeps the quiet terminal surface, blue focus color, and
 * warm command accent instead of turning light mode into a plain gray port.
 *
 * The exported `Theme` shape preserves the keys consumed by the rest of the
 * TUI so no caller needs to change.
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

  // User message surface (opencode-style: no bubble, just text color)
  userMessageBorder: string;
  userMessageBg: string;
  userMessageText: string;
  userRail: string;

  // Diff
  diffAdd: string;
  diffRemove: string;
  diffAddFg: string;
  diffRemoveFg: string;

  // Per-tool category (used by toolAccent helper)
  toolFile: string;
  toolShell: string;
  toolSearch: string;
  toolThink: string;
  toolNet: string;
  toolEdit: string;

  // Brand
  brand: string;
  brandSoft: string;
  brandDeep: string;

  // opencode-style additions
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  text: string;
  textMuted: string;
  textDim: string;
  surface: string;
  shade: string;
}

/**
 * 12-step grayscale + lavender accent.
 *
 *  step1  #0a0a0a  root bg
 *  step2  #141414  panel bg (dialogs, chips)
 *  step3  #1c1820  element bg (input fill, slightly purple-tinged)
 *  step4  #232028  surface  (current input bg base)
 *  step5  #2a2630  raised panel
 *  step6  #3a3242  borderSubtle
 *  step7  #4a4254  border
 *  step8  #5e5570  borderActive
 *  step9  #bd91db  accent / primary       ← brand
 *  step10 #d4afe8  accent hover / soft
 *  step11 #808080  text muted
 *  step12 #eeeeee  text
 */
export const darkTheme: Theme = {
  user: "#8E3A52",        // user messages render in accent — opencode pattern
  agent: "#EEEEEE",       // assistant messages render in full white
  error: "#E06C75",
  warning: "#F5A742",
  success: "#7FD88F",

  accent: "#8E3A52",
  border: "#4A3A40",
  borderActive: "#8E3A52",
  inputBorder: "#8E3A52",          // heavy left rail color
  inputBorderDisabled: "#3A2A2F",
  inputBg: "#1A1014",              // surface — slightly raised from root
  inputBgDisabled: "#141414",
  inputText: "#EEEEEE",
  inputPlaceholder: "#808080",
  muted: "#808080",
  dim: "#606070",

  thinking: "#6B2A3E",
  thinkingDim: "#808080",
  toolName: "#808080",             // tool header lines are dim (opencode pattern)
  toolResult: "#EEEEEE",
  toolError: "#E06C75",
  toolPending: "#F5A742",
  code: "#7FD88F",
  traceAction: "#8E3A52",
  traceCount: "#808080",
  traceDetail: "#606070",
  traceCommand: "#56B6C2",
  tracePending: "#F5A742",

  userMessageBorder: "transparent",  // unused under opencode style
  userMessageBg: "transparent",
  userMessageText: "#8E3A52",        // user message body color
  userRail: "#8E3A52",

  diffAdd: "#20303B",
  diffRemove: "#37222C",
  diffAddFg: "#4FD6BE",
  diffRemoveFg: "#C53B53",

  toolFile:   "#7FD88F",
  toolShell:  "#F5A742",
  toolSearch: "#56B6C2",
  toolThink:  "#6B2A3E",
  toolNet:    "#5C9CF5",
  toolEdit:   "#8E3A52",

  brand:      "#8E3A52",
  brandSoft:  "#B85574",
  brandDeep:  "#6B2A3E",

  background:         "#0A0A0A",
  backgroundPanel:    "#141414",
  backgroundElement:  "#1A1014",
  text:               "#EEEEEE",
  textMuted:          "#808080",
  textDim:            "#606070",
  surface:            "#1A1014",
  shade:              "#141414",
};

export const lightTheme: Theme = {
  user: "#356FD2",
  agent: "#171717",
  error: "#B62633",
  warning: "#8B4A00",
  success: "#2F7D4A",

  accent: "#8B4A00",
  border: "#B9BDB8",
  borderActive: "#356FD2",
  inputBorder: "#356FD2",
  inputBorderDisabled: "#D7DAD4",
  inputBg: "#FCFCFA",
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

  userMessageBorder: "transparent",
  userMessageBg: "transparent",
  userMessageText: "#234B93",
  userRail: "#356FD2",

  diffAdd: "#D7E8D8",
  diffRemove: "#F7DADC",
  diffAddFg: "#173D2D",
  diffRemoveFg: "#5D1922",

  toolFile:   "#2F7D4A",
  toolShell:  "#257E8A",
  toolSearch: "#356FD2",
  toolThink:  "#5F666D",
  toolNet:    "#356FD2",
  toolEdit:   "#8B4A00",

  brand:      "#8B4A00",
  brandSoft:  "#B86B15",
  brandDeep:  "#5A2F00",

  background:         "#FCFCFA",
  backgroundPanel:    "#F6F6F3",
  backgroundElement:  "#ECEDEA",
  text:               "#171717",
  textMuted:          "#6F7377",
  textDim:            "#8B9094",
  surface:            "#FCFCFA",
  shade:              "#F6F6F3",
};

const ThemeContext = createContext<Theme>(darkTheme);
export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

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

/** opencode style: tool category is encoded by header text, not color. Keep
 * a single accent for tool names so users get visual consistency. */
export function toolAccent(theme: Theme, _toolName: string): string {
  return theme.text;
}
