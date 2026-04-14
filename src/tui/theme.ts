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
  accent: "cyan",
  border: "gray",
  borderActive: "cyan",
  muted: "gray",

  // Content
  thinking: "magenta",
  toolName: "cyan",
  toolResult: "gray",
  toolError: "red",
  code: "yellow",

  // Message surfaces
  userMessageBorder: "red",
  userMessageBg: "#2a2a34",
  userMessageText: "#f3f3f7",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
