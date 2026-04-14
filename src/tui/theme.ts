/**
 * Lightweight color theme for the TUI.
 */

export const theme = {
  // Actors
  user: "green",
  agent: "blue",
  error: "red",
  warning: "yellow",

  // UI chrome
  border: "gray",
  borderActive: "cyan",
  muted: "gray",

  // Content
  thinking: "magenta",
  toolName: "cyan",
  toolResult: "gray",
  toolError: "red",
  code: "yellow",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
