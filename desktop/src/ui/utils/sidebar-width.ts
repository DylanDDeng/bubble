// Fixed-width workspace switcher at the window's left edge (matches .bubble-workspace-rail).
export const WORKSPACE_RAIL_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 220;
export const DEFAULT_SIDEBAR_WIDTH = 310;
export const MAX_SIDEBAR_WIDTH = 420;
export const SIDEBAR_WIDTH_VERSION = 9;

export function sanitizeSidebarWidth(
  width: number | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH
): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return fallback;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function restorePersistedSidebarWidth(
  width: number | undefined,
  persistedVersion: number | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH
): number {
  if (persistedVersion === SIDEBAR_WIDTH_VERSION) {
    return sanitizeSidebarWidth(width, fallback);
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

// Workspaces unrelated to sessions show only the rail, never the session panel.
export function workspaceHasSidebarPanel(activeWorkspace: string) {
  return activeWorkspace !== 'skills';
}

// Board preferences are independent of the conversation/sidebar preferences.
export function selectSidebarCollapsed(state: { activeWorkspace: string; sidebarCollapsed: boolean; boardSidebarCollapsed: boolean }) {
  if (!workspaceHasSidebarPanel(state.activeWorkspace)) return true;
  return state.activeWorkspace === 'board' ? state.boardSidebarCollapsed : state.sidebarCollapsed;
}
export function selectSidebarWidth(state: { activeWorkspace: string; sidebarWidth: number; boardSidebarWidth: number }) {
  return state.activeWorkspace === 'board' ? state.boardSidebarWidth : state.sidebarWidth;
}
