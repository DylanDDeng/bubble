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

  // Message surfaces — user input is rendered as a left rail rather than a
  // full-width filled block, so most terminals (light or dark) stay readable.
  userMessageBorder: "#8A7FC6",
  userMessageBg: "#2a2a34", // retained for callers still wanting fill
  userMessageText: "#f3f3f7",
  userRail: "#8A7FC6",

  // Diff
  diffAdd: "#1a3d1a",
  diffRemove: "#3d1a1a",
  diffAddFg: "#9CDCFE",
  diffRemoveFg: "#F48771",

  // Context budget bar thresholds
  contextOk: "gray",
  contextWarn: "yellow",
  contextCrit: "red",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
