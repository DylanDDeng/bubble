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
  plan: { title: "Plan", shortTitle: "plan", symbol: "⏸", color: "accent" },
  bypassPermissions: { title: "Bypass permissions", shortTitle: "bypass permission", symbol: "⏵⏵", color: "error" },
};

/**
 * Cycle order for the interactive mode keybind. The visible TUI loop keeps the
 * mental model simple: Build -> Plan -> Bypass -> Build.
 */
export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  if (current === "default") return "plan";
  if (current === "plan") return "bypassPermissions";
  return "default";
}
