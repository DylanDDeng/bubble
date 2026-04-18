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
 * Cycle order when the user presses Shift+Tab. `bypassPermissions` is only
 * included if the session was started with --dangerously-skip-permissions so
 * we never accidentally cycle users into a dangerous mode. `dontAsk` is never
 * cycled — it can only be set programmatically.
 */
export function getNextPermissionMode(
  current: PermissionMode,
  options: { bypassEnabled?: boolean } = {},
): PermissionMode {
  const cycle: PermissionMode[] = ["default", "acceptEdits", "plan"];
  if (options.bypassEnabled) cycle.push("bypassPermissions");
  const index = cycle.indexOf(current);
  if (index === -1) return "default"; // current is dontAsk or otherwise out-of-cycle
  return cycle[(index + 1) % cycle.length];
}
