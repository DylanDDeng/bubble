// 浏览器面板共享类型（主进程 + 渲染进程通用）
// 基于 Synara（原 dpcode，Emanuele-web04/synara）的 ThreadBrowserState 适配，
// 并与本项目以 sessionId 为粒度的会话绑定。

export type BrowserTabStatus = 'live' | 'suspended';

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  status: BrowserTabStatus;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
  /** Chromium net error behind `lastError`; only meaningful while `lastError` is set. */
  lastErrorCode?: number | null;
  zoomPercent?: number;
  /** Find-in-page results; null when no search is active. */
  findMatches?: { active: number; total: number } | null;
}

export type BrowserZoomAction = 'in' | 'out' | 'reset';

export interface BrowserZoomInput extends BrowserTabInput {
  action: BrowserZoomAction;
}

export interface BrowserFindInput extends BrowserTabInput {
  text: string;
  forward?: boolean;
  /** Continue the current search (Enter / Shift+Enter) instead of starting a new one. */
  next?: boolean;
}

/** Page-side requests the panel must act on (keys pressed while the page has focus, link menu actions). */
export type BrowserPanelEvent =
  | { type: 'find' | 'find-next' | 'find-previous' | 'find-close'; sessionId: string; tabId: string }
  | { type: 'open-in-new-tab'; sessionId: string; tabId: string; url: string };

export interface SessionBrowserState {
  sessionId: string;
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  lastError: string | null;
  /** True while an agent-driven browser_use action is executing on the
   * active tab — the panel shows an agent badge so the user knows who is
   * driving (Codex parity for visible browser use). */
  agentActive: boolean;
}

export const BROWSER_SESSION_PARTITION = 'persist:coworker-browser';

export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ===== IPC 输入类型 =====

export interface BrowserSessionInput {
  sessionId: string;
}

export interface BrowserOpenInput extends BrowserSessionInput {
  initialUrl?: string;
}

export interface BrowserNavigateInput extends BrowserSessionInput {
  tabId?: string;
  url: string;
}

export interface BrowserTabInput extends BrowserSessionInput {
  tabId: string;
}

export interface BrowserCaptureInput extends BrowserTabInput {
  /** `jpeg` returns only a light `dataUrl`, for on-screen page snapshots. */
  format?: 'png' | 'jpeg';
}

export interface BrowserNewTabInput extends BrowserSessionInput {
  url?: string;
  activate?: boolean;
}

export interface BrowserSetPanelBoundsInput extends BrowserSessionInput {
  bounds: BrowserPanelBounds | null;
}

/** Chromium only clears these for all time; history lives in the renderer and honors a range. */
export type BrowserClearDataType = 'siteData' | 'cache';

export interface BrowserDataSummary {
  cookieSiteCount: number;
  cacheBytes: number;
}

// ===== 截图 / 正文读取 =====

export interface BrowserCapturePageResult {
  ok: boolean;
  message?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  base64?: string;
  pageUrl?: string;
  pageTitle?: string;
}

export interface BrowserReadoutLink {
  url: string;
  text: string;
}

export interface BrowserReadoutResult {
  ok: boolean;
  message?: string;
  url?: string;
  title?: string;
  text?: string;
  selection?: string;
  links?: BrowserReadoutLink[];
}

// Emitted from the main process when the user chooses "Send selection to chat"
// in the in-app browser's native context menu.
export interface BrowserSendSelectionEvent {
  sessionId: string;
  tabId: string;
  selectionText: string;
  pageUrl: string;
  pageTitle: string;
}
