/**
 * Lightweight color theme for the TUI.
 */

export const theme = {
  // Actors
  user: "green",
  agent: "blue",
  error: "red",
  warning: "yellow",
  success: "green",

  // UI chrome
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

  // Content
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

  // Message surfaces — user input uses a subtle fill plus a left rail so it is
  // visually separate from assistant/tool trace output without becoming noisy.
  userMessageBorder: "#8A7FC6",
  userMessageBg: "#2a2a34",
  userMessageText: "#f3f3f7",
  userRail: "#8A7FC6",

  // Diff
  diffAdd: "#1a3d1a",
  diffRemove: "#3d1a1a",
  diffAddFg: "#9CDCFE",
  diffRemoveFg: "#F48771",

} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
