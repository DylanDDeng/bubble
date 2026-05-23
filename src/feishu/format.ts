/**
 * Small formatting helpers shared across the Feishu host.
 */

import type { PermissionMode } from "../types.js";

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "default",
  plan: "plan",
  bypassPermissions: "bypass",
};

export function formatPermissionMode(mode: PermissionMode): string {
  return MODE_LABELS[mode] ?? mode;
}

export function isPermissionModeName(value: string): value is PermissionMode {
  return value === "default" || value === "plan" || value === "bypassPermissions";
}
