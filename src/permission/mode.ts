import type { PermissionMode } from "../types.js";

/**
 * Display metadata for each permission mode. Mirrors Claude Code's
 * PERMISSION_MODE_CONFIG — kept narrow to what the TUI needs today.
 */
export interface PermissionModeInfo {
  title: string;
  shortTitle: string;
  /** Single/double-char prefix shown in the footer badge. Empty = no badge. */
  symbol: string;
  /** Theme colour key. */
  color: "muted" | "accent" | "success" | "warning" | "error";
}

export const PERMISSION_MODE_INFO: Record<PermissionMode, PermissionModeInfo> = {
  default: { title: "Default", shortTitle: "default", symbol: "", color: "muted" },
  acceptEdits: { title: "Accept edits", shortTitle: "accept edits", symbol: "⏵⏵", color: "success" },
  plan: { title: "Plan", shortTitle: "plan", symbol: "⏸", color: "accent" },
  bypassPermissions: { title: "Bypass permissions", shortTitle: "bypass", symbol: "⏵⏵", color: "error" },
  dontAsk: { title: "Do not ask", shortTitle: "silent", symbol: "·", color: "warning" },
};

/**
 * Cycle order for the interactive mode keybind. This intentionally mirrors
 * opencode's primary-agent switch: the keybind toggles Build and Plan only.
 * Permission presets like acceptEdits/bypassPermissions remain opt-in through
 * flags or commands and are never reached accidentally from Tab.
 */
export function getNextPermissionMode(
  current: PermissionMode,
  _options: { bypassEnabled?: boolean } = {},
): PermissionMode {
  if (current === "plan") return "default";
  if (current === "bypassPermissions" || current === "dontAsk") return "default";
  return "plan";
}
