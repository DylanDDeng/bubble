// Per-session in-app browser panel.
//
// Architecture (adapted from Synara's, formerly dpcode, BrowserPanel.tsx):
// - Main process owns the actual Chromium WebContentsView. This component only
//   renders chrome (address bar, tab strip, buttons) and reserves a viewport
//   div whose bounds are forwarded to the main process so the native view is
//   mirrored on top of the React tree.
// - State is sourced from two places:
//     1. `window.electron.browser.onState` broadcast (live source of truth).
//     2. `useBrowserStateStore` persisted cache (instant paint on session switch).
// - Three AI-integration actions live here:
//     1. Screenshot the active tab and attach to chat.
//     2. Readout the page (text + selection + top links) into the prompt.
//     3. "Send selection to chat" fired from the browser native context menu.
//
// Keep this component resilient to background session switches: we always pass
// the explicit `sessionId` prop to IPC calls and filter onState events.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Code2,
  Copy,
  ExternalLink,
  FileImport,
  FileText,
  Loader2,
  Minus,
  MoreHorizontal,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ZoomIn,
} from '../icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'sonner';
import type {
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserTabState,
  BrowserZoomAction,
  SessionBrowserState,
} from '../../../shared/browser-types';
import type { Attachment } from '../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import {
  useBrowserStateStore,
  type PersistedBrowserTab,
  type PersistedSessionBrowserState,
} from '../../store/useBrowserStateStore';
import {
  browserAddressDisplayValue,
  browserAddressRestingValue,
  isImeComposing,
  normalizeBrowserAddressInput,
  resolveBrowserAddressSync,
  resolveBrowserChromeStatus,
} from './BrowserPanel.logic';
import { useBrowserNativeOverlay } from './browser-native-overlay';
import { BrowserImportBanner, BrowserLoadErrorPage, BrowserStartPage } from './BrowserStartPage';
import { BrowserFindBar } from './BrowserFindBar';
import { browserUtilityTabForSession, openBrowserTab } from '../../utils/open-browser-tab';
import { BrowserImportDialog } from './BrowserImportDialog';
import { BrowserClearDataDialog } from './BrowserClearDataDialog';
import type { BrowserImportSourceInfo } from '../../types';

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const DEFAULT_HOME_URL = 'about:blank';
const READOUT_TEXT_CHAR_LIMIT = 6000;
const READOUT_LINK_LIMIT = 15;
const SNAPSHOT_TIMEOUT_MS = 400;
const SNAPSHOT_RELEASE_MS = 250;
const ZOOM_FLASH_MS = 2500;
// Room kept on BOTH sides of the address text so the zoom control never shifts its centering.
const ZOOM_RESERVE_COMPACT_PX = 50;
const ZOOM_RESERVE_EXPANDED_PX = 96;
const TOOLBAR_BUTTON_CLASS =
  'inline-flex h-7 w-7 items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]';
const MENU_ITEM_CLASS = 'gap-2.5 py-1.5 text-[13px]';

// Shared by every panel: detection extracts app icons, so it runs once per app launch.
let importPromptRequest: Promise<BrowserImportSourceInfo[]> | null = null;
function loadImportPromptSources(): Promise<BrowserImportSourceInfo[]> {
  importPromptRequest ??= Promise.all([
    window.electron.detectBrowserImportSources(),
    window.electron.getChromeCookieImportStatus(),
  ])
    .then(([detected, status]) => (status.importedAt ? [] : detected.sources))
    .catch(() => []);
  return importPromptRequest;
}

interface BrowserPanelProps {
  // The chat session to inject "send to chat" output into. Null when the
  // browser is used standalone (no conversation open) — in that case the
  // to-chat actions create a new draft conversation on demand.
  sessionId: string | null;
  browserSessionId?: string;
  collapsed: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  topInset?: number;
  embedded?: boolean;
  bottomInset?: number;
}

function persistedToState(state: PersistedSessionBrowserState): SessionBrowserState {
  return {
    sessionId: state.sessionId,
    open: true,
    activeTabId: state.activeTabId,
    tabs: state.tabs.map(
      (tab: PersistedBrowserTab): BrowserTabState => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        status: 'suspended',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: tab.faviconUrl,
        lastCommittedUrl: tab.url,
        lastError: null,
      })
    ),
    lastError: null,
    agentActive: false,
  };
}

function stateToPersisted(state: SessionBrowserState): PersistedSessionBrowserState {
  return {
    sessionId: state.sessionId,
    activeTabId: state.activeTabId,
    updatedAt: Date.now(),
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      faviconUrl: tab.faviconUrl,
    })),
  };
}

export function BrowserPanel({
  sessionId,
  browserSessionId: browserSessionIdProp,
  collapsed,
  width,
  onWidthChange,
  isFullscreen,
  onToggleFullscreen,
  topInset = 0,
  embedded = false,
  bottomInset = 0,
}: BrowserPanelProps) {
  const browserSessionId = browserSessionIdProp ?? sessionId ?? '__standalone-browser__';
  const overlayOpen = useBrowserNativeOverlay();
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);
  const createDraftSession = useAppStore((s) => s.createDraftSession);
  // Target chat session for "send to chat" actions; create a draft if browsing
  // standalone (no conversation open).
  const resolveChatTargetId = useCallback(
    () => sessionId ?? createDraftSession(),
    [sessionId, createDraftSession]
  );

  const cachedSessionState = useBrowserStateStore(
    (s) => s.sessionStatesBySessionId[browserSessionId] ?? null
  );
  const upsertSessionState = useBrowserStateStore((s) => s.upsertSessionState);
  const removeSessionState = useBrowserStateStore((s) => s.removeSessionState);
  const recordHistoryEntry = useBrowserStateStore((s) => s.recordHistoryEntry);

  const [sessionState, setSessionState] = useState<SessionBrowserState>(() => {
    if (cachedSessionState) return persistedToState(cachedSessionState);
    return {
      sessionId: browserSessionId,
      open: false,
      activeTabId: null,
      tabs: [],
      lastError: null,
      agentActive: false,
    };
  });

  const activeTab = useMemo<BrowserTabState | null>(() => {
    if (!sessionState.activeTabId) return null;
    return sessionState.tabs.find((tab) => tab.id === sessionState.activeTabId) ?? null;
  }, [sessionState]);

  // ===== 地址栏本地编辑状态 =====
  const [addressValue, setAddressValue] = useState('');
  const [addressEditing, setAddressEditing] = useState(false);
  const [addressDrafts, setAddressDrafts] = useState<Record<string, string>>({});
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyBySession = useBrowserStateStore(s => s.recentHistoryBySessionId);
  const history = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(historyBySession).flat().sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .filter(item => {
        if (seen.has(item.url) || !/^https?:\/\//i.test(item.url)) return false;
        seen.add(item.url); return true;
      }).slice(0, 12);
  }, [historyBySession]);
  const matchingHistory = history.filter(item => !addressValue || `${item.title} ${item.url}`.toLowerCase().includes(addressValue.toLowerCase()));
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [importSources, setImportSources] = useState<BrowserImportSourceInfo[]>([]);
  const importPromptDismissed = useBrowserStateStore((s) => s.importPromptDismissed);
  const dismissImportPrompt = useBrowserStateStore((s) => s.dismissImportPrompt);
  const [pageSnapshot, setPageSnapshot] = useState<{ key: string; src: string | null } | null>(null);
  const showStartPage = !activeTab || !activeTab.url || activeTab.url === DEFAULT_HOME_URL;
  // The failed page is blank and would cover the error, so the panel draws it.
  const loadError = !showStartPage && activeTab && !activeTab.isLoading ? activeTab.lastError : null;
  const pageCovered = collapsed || showStartPage || !!loadError;
  const snapshotKey = activeTab ? `${browserSessionId}:${activeTab.id}:${activeTab.url}` : '';
  const frozenPage = pageSnapshot?.key === snapshotKey ? pageSnapshot : null;
  // App-level overlays (tab menus, dialogs) also wait for the snapshot, so the page never blanks behind them.
  const pageAlreadyHidden = pageCovered || (overlayOpen && !!frozenPage);
  // The native view paints above the DOM; suggestions wait for the snapshot that stands in for it.
  const historyOpen = addressEditing && matchingHistory.length > 0 && (pageAlreadyHidden || !!frozenPage);
  // The start page, error page and address suggestions are React surfaces.
  const nativeViewHidden = pageAlreadyHidden || historyOpen || menuOpen;

  const lastSyncedAddressRef = useRef<string | undefined>(undefined);
  const previousActiveTabIdRef = useRef<string | null>(null);

  const [localError, setLocalError] = useState<string | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [readoutBusy, setReadoutBusy] = useState(false);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const lastRecordedUrlRef = useRef<string | null>(null);

  const freezingKeyRef = useRef<string | null>(null);
  const freezePage = useCallback(async () => {
    if (!activeTab || pageCovered || frozenPage || freezingKeyRef.current === snapshotKey) return;
    const key = snapshotKey;
    freezingKeyRef.current = key;
    const capture = () =>
      window.electron.browser
        .capture({ sessionId: browserSessionId, tabId: activeTab.id, format: 'jpeg' })
        .catch(() => null);
    const result = await Promise.race([
      capture().then((first) => (first?.ok ? first : capture())),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS)),
    ]);
    const src = result?.ok && result.dataUrl ? result.dataUrl : null;
    // Decode first: an undecoded <img> paints a blank frame where the page was.
    if (src) {
      const image = new Image();
      image.src = src;
      await image.decode().catch(() => {});
    }
    if (freezingKeyRef.current === key) freezingKeyRef.current = null;
    setPageSnapshot({ key, src });
  }, [activeTab, browserSessionId, frozenPage, pageCovered, snapshotKey]);

  useEffect(() => {
    if (overlayOpen && !frozenPage) void freezePage();
  }, [overlayOpen, frozenPage, freezePage]);

  useEffect(() => {
    if (addressEditing || menuOpen || overlayOpen || !pageSnapshot) return;
    const timer = window.setTimeout(() => setPageSnapshot(null), SNAPSHOT_RELEASE_MS);
    return () => window.clearTimeout(timer);
  }, [addressEditing, menuOpen, overlayOpen, pageSnapshot]);

  useEffect(() => {
    if (collapsed || importPromptDismissed) return;
    let cancelled = false;
    void loadImportPromptSources().then((sources) => {
      if (!cancelled) setImportSources(sources);
    });
    return () => {
      cancelled = true;
    };
  }, [collapsed, importPromptDismissed]);

  const handleImported = useCallback(() => {
    importPromptRequest = Promise.resolve([]);
    setImportSources([]);
  }, []);

  useLayoutEffect(() => {
    if (addressEditing) addressInputRef.current?.select();
  }, [addressEditing]);

  // ===== Find in page =====
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findTabId = showStartPage || loadError ? null : activeTab?.id ?? null;
  const findTargetRef = useRef<{ tabId: string | null; query: string }>({ tabId: null, query: '' });
  findTargetRef.current = { tabId: findTabId, query: findQuery };

  const runFind = useCallback(
    (options: { forward?: boolean; next?: boolean } = {}) => {
      const { tabId, query } = findTargetRef.current;
      if (!tabId) return;
      void window.electron.browser.find({ sessionId: browserSessionId, tabId, text: query, ...options }).catch(() => {});
    },
    [browserSessionId]
  );
  const openFind = useCallback(() => {
    if (!findTargetRef.current.tabId) return;
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    const { tabId } = findTargetRef.current;
    if (tabId) void window.electron.browser.stopFind({ sessionId: browserSessionId, tabId }).catch(() => {});
  }, [browserSessionId]);

  useEffect(() => {
    if (findOpen) runFind();
  }, [findOpen, findQuery, runFind]);
  // A new document (or a different tab) invalidates the matches; search it again.
  useEffect(() => {
    if (findOpen && findTargetRef.current.query) runFind();
  }, [activeTab?.url, findOpen, runFind]);
  useEffect(() => {
    if (findOpen && (!findTabId || collapsed)) closeFind();
  }, [findOpen, findTabId, collapsed, closeFind]);

  // Shortcuts pressed while the page has focus arrive from the main process.
  useEffect(() => {
    return window.electron.browser.onPanelEvent((event) => {
      if (event.sessionId !== browserSessionId) return;
      if (event.type === 'open-in-new-tab') {
        openBrowserTab({ url: event.url, after: browserUtilityTabForSession(browserSessionId) });
      } else if (event.type === 'find') {
        openFind();
      } else if (event.type === 'find-close') {
        closeFind();
      } else if (findTargetRef.current.query) {
        if (!findOpen) openFind();
        runFind({ forward: event.type === 'find-next', next: true });
      } else {
        openFind();
      }
    });
  }, [browserSessionId, closeFind, findOpen, openFind, runFind]);

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
    event.preventDefault();
    openFind();
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (!open) {
      setMenuOpen(false);
      return;
    }
    void freezePage().then(() => setMenuOpen(true));
  };

  // ===== Design mode =====
  // The design session is keyed by the (browserSessionId, tabId) it was
  // ENABLED for — disable must use that stored pair, not the current props:
  // after a chat-session switch browserSessionId changes and a disable built
  // from it would miss the service's session map, leaking the pinned
  // WebContentsView and leaving the page's clicks hijacked by the inspector
  // (review finding).
  const [designTarget, setDesignTarget] = useState<{ browserSessionId: string; tabId: string; token?: number } | null>(null);
  const projectRoot = useAppStore((s) => (sessionId ? s.sessions[sessionId]?.cwd ?? null : null));

  const disableDesignMode = useCallback(() => {
    setDesignTarget((current) => {
      if (current) {
        void window.electron.designMode.disable({
          sessionId: current.browserSessionId,
          tabId: current.tabId,
          token: current.token,
        });
      }
      return null;
    });
  }, []);

  // The enable round-trip (inject + probe) is slow enough for the user to
  // collapse the panel or switch tabs mid-flight; a resolved enable must not
  // record a target the cleanup effects have already stopped watching, or
  // the pinned session + click-hijacking inspector leak (codex review).
  const designContextRef = useRef('');
  const toggleDesignMode = useCallback(async () => {
    if (designTarget) {
      disableDesignMode();
      return;
    }
    const tab = sessionState.activeTabId
      ? sessionState.tabs.find((item) => item.id === sessionState.activeTabId) ?? null
      : null;
    if (!tab) return;
    if (!projectRoot) {
      toast.error('Design mode needs an open project session (annotations carry project context).');
      return;
    }
    const contextAtStart = designContextRef.current;
    const enabled = await window.electron.designMode.enable({
      sessionId: browserSessionId,
      tabId: tab.id,
      projectRoot,
    });
    if (!enabled.ok) {
      toast.error(enabled.message || 'Failed to enable design mode');
      return;
    }
    if (designContextRef.current !== contextAtStart) {
      // Panel collapsed / tab or session switched while enable was in flight.
      // Token-scoped: this must tear down OUR stale session only, never a
      // successor a reopened panel installed under the same key.
      void window.electron.designMode.disable({ sessionId: browserSessionId, tabId: tab.id, token: enabled.token });
      return;
    }
    setDesignTarget({ browserSessionId, tabId: tab.id, token: enabled.token });
  }, [designTarget, disableDesignMode, sessionState, projectRoot, browserSessionId]);

  // Design mode is bound to one tab of one browser session: leaving it in
  // ANY direction (tab switch, chat-session switch, panel collapse) ends the
  // design session explicitly.
  useEffect(() => {
    if (!designTarget) return;
    if (
      collapsed ||
      browserSessionId !== designTarget.browserSessionId ||
      sessionState.activeTabId !== designTarget.tabId
    ) {
      disableDesignMode();
    }
  }, [collapsed, browserSessionId, sessionState.activeTabId, designTarget, disableDesignMode]);

  // Unmount cleanup: closing the browser utility tab must release the design
  // session (pin + poll timer + in-page inspector), not leak it.
  useEffect(() => () => disableDesignMode(), [disableDesignMode]);

  // Staleness fingerprint for in-flight enables: any change here (or unmount)
  // invalidates an enable() that resolves afterwards.
  useEffect(() => {
    designContextRef.current = `${collapsed}:${browserSessionId}:${sessionState.activeTabId ?? ''}`;
    return () => {
      designContextRef.current = '__unmounted__';
    };
  }, [collapsed, browserSessionId, sessionState.activeTabId]);

  // The service emits 'disabled' when it tears a session down (page gone,
  // left localhost, host reload); clear the UI target without re-invoking
  // IPC (idempotent server-side). Annotate delivery lives in the app-level
  // DesignAnnotateBridge, independent of this panel's lifetime.
  useEffect(() => {
    return window.electron.designMode.onEvent((event) => {
      if (event.kind !== 'disabled') return;
      setDesignTarget((current) =>
        current && current.tabId === event.tabId && current.browserSessionId === event.sessionId
          ? null
          : current
      );
    });
  }, []);

  // ===== 订阅主进程状态 =====
  useEffect(() => {
    if (collapsed) return;

    let cancelled = false;
    const api = window.electron.browser;
    // After a relaunch the main process has no tabs; seed it with the page this
    // panel had (persisted renderer state), or the open reply resets it to blank.
    const cached = useBrowserStateStore.getState().sessionStatesBySessionId[browserSessionId];
    const cachedTab = cached?.tabs.find((tab) => tab.id === cached.activeTabId) ?? cached?.tabs[0];
    lastRecordedUrlRef.current = null;

    api
      .open({ sessionId: browserSessionId, initialUrl: cachedTab?.url || DEFAULT_HOME_URL })
      .then((state) => {
        if (cancelled) return;
        setSessionState(state);
        upsertSessionState(stateToPersisted(state));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLocalError(String(error));
      });

    const dispose = api.onState((nextState) => {
      if (nextState.sessionId !== browserSessionId) return;
      setSessionState(nextState);
      upsertSessionState(stateToPersisted(nextState));
      const active = nextState.tabs.find((tab) => tab.id === nextState.activeTabId);
      if (!active || !active.url || active.url === DEFAULT_HOME_URL) return;
      const known = useBrowserStateStore
        .getState()
        .recentHistoryBySessionId[browserSessionId]?.find((entry) => entry.url === active.url);
      // A new URL is a visit; later title/icon updates only refresh an entry still in history.
      const isNewVisit = active.url !== lastRecordedUrlRef.current;
      if (isNewVisit || (known && (known.title !== active.title || known.faviconUrl !== active.faviconUrl))) {
        lastRecordedUrlRef.current = active.url;
        recordHistoryEntry(browserSessionId, {
          url: active.url,
          title: active.title,
          faviconUrl: active.faviconUrl,
          lastVisitedAt: Date.now(),
        });
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [browserSessionId, collapsed, recordHistoryEntry, upsertSessionState]);

  // Revoke the native viewport during the layout commit, before the next
  // conversation paints. Passive cleanup leaves the old page floating over it.
  const visibleBrowserSessionRef = useRef<string | null>(null);
  // Bounds last sent for the visible view; identical rects are not resent.
  const lastPushedBoundsRef = useRef<string | null>(null);
  // Read by effect cleanups, which run after the NEXT render has set these.
  const snapshotStandsInRef = useRef(false);
  snapshotStandsInRef.current = !pageCovered && !!frozenPage?.src;
  const nativeViewHiddenRef = useRef(nativeViewHidden);
  nativeViewHiddenRef.current = nativeViewHidden;
  const browserSessionIdRef = useRef(browserSessionId);
  browserSessionIdRef.current = browserSessionId;
  useLayoutEffect(() => {
    const hide = () => {
      visibleBrowserSessionRef.current = null;
      void window.electron.browser.hide({ sessionId: browserSessionId }).catch(() => {});
    };
    visibleBrowserSessionRef.current = nativeViewHidden ? null : browserSessionId;
    // hide() revokes the bounds in the main process; the next show must resend.
    lastPushedBoundsRef.current = null;
    if (!nativeViewHidden) {
      return () => {
        // Going behind a snapshot: the next run hides once the snapshot is on screen.
        const nextBehindSnapshot =
          browserSessionIdRef.current === browserSessionId && nativeViewHiddenRef.current && snapshotStandsInRef.current;
        if (nextBehindSnapshot) visibleBrowserSessionRef.current = null;
        else hide();
      };
    }
    if (!snapshotStandsInRef.current) {
      hide();
      return hide;
    }
    // The main process drops the view within milliseconds, but the snapshot
    // only reaches the screen with the next frame; in between the page blanks.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(hide);
    });
    return () => {
      cancelAnimationFrame(frame);
      hide();
    };
  }, [browserSessionId, nativeViewHidden]);

  // ===== Context menu -> send selection to chat =====
  useEffect(() => {
    const api = window.electron.browser;
    const dispose = api.onSendSelection((event: BrowserSendSelectionEvent) => {
      if (event.sessionId !== browserSessionId) return;
      const quoted = event.selectionText
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const text = `From [${event.pageTitle || event.pageUrl}](${event.pageUrl}):\n\n${quoted}`;
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text,
        mode: 'append',
        source: 'browser:selection',
      });
      toast.success('Selection sent to chat');
    });
    return () => dispose();
  }, [browserSessionId, requestChatInjection, sessionId]);

  // ===== 地址栏同步 =====
  const nextDisplayValue = browserAddressDisplayValue(activeTab);
  useEffect(() => {
    const decision = resolveBrowserAddressSync({
      activeTabId: sessionState.activeTabId,
      previousActiveTabId: previousActiveTabIdRef.current,
      savedDraft: sessionState.activeTabId
        ? addressDrafts[sessionState.activeTabId]
        : undefined,
      nextDisplayValue,
      lastSyncedValue: lastSyncedAddressRef.current,
      isEditing: addressEditing,
    });
    previousActiveTabIdRef.current = sessionState.activeTabId;
    if (decision.type === 'replace') {
      setAddressValue(decision.value);
      lastSyncedAddressRef.current = decision.syncedValue;
    }
    // We intentionally omit addressDrafts/addressEditing from deps because the
    // decision layer handles those via ref-like inputs to avoid sync loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState.activeTabId, nextDisplayValue]);

  const chromeStatus = useMemo(
    () =>
      resolveBrowserChromeStatus({
        localError,
        sessionLastError: sessionState.lastError,
        activeTabStatus: activeTab?.status ?? 'suspended',
        hasActiveTab: !!activeTab,
        workspaceReady: sessionState.open,
      }),
    [activeTab, localError, sessionState.lastError, sessionState.open]
  );

  // ===== Viewport bounds sync =====
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const pushBounds = useCallback(() => {
    if (nativeViewHidden || visibleBrowserSessionRef.current !== browserSessionId) return;
    // A queued resize/animation callback can run after the store switches but
    // before React cleans up this panel. It must not reattach the old page.
    if (useAppStore.getState().activeSessionId !== sessionId) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const key = `${browserSessionId}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key === lastPushedBoundsRef.current) return;
    lastPushedBoundsRef.current = key;
    window.electron.browser
      .setPanelBounds({ sessionId: browserSessionId, bounds })
      .catch(() => {
        lastPushedBoundsRef.current = null;
      });
  }, [browserSessionId, nativeViewHidden, sessionId]);

  useLayoutEffect(() => {
    pushBounds();
  }, [pushBounds, width, nativeViewHidden]);

  useEffect(() => {
    if (nativeViewHidden) return;
    const el = viewportRef.current;
    if (!el) return;
    // ResizeObserver runs after layout and before paint: push in the same
    // frame. Deferring to requestAnimationFrame cost the view one more frame.
    const observer = new ResizeObserver(() => pushBounds());
    observer.observe(el);
    const onWindowResize = () => pushBounds();
    window.addEventListener('resize', onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [nativeViewHidden, pushBounds]);

  // When the animation transitions, push bounds repeatedly for a short burst.
  useEffect(() => {
    if (nativeViewHidden) return;
    let frames = 0;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      pushBounds();
      frames += 1;
      if (frames < 18) {
        requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
    return () => {
      stopped = true;
    };
  }, [nativeViewHidden, width, pushBounds]);

  // ===== 操作封装 =====
  const handleNavigate = useCallback(
    async (rawInput: string) => {
      const normalized = normalizeBrowserAddressInput(rawInput);
      try {
        const next = await window.electron.browser.navigate({
          sessionId: browserSessionId,
          tabId: sessionState.activeTabId ?? undefined,
          url: normalized,
        });
        setSessionState(next);
        setAddressEditing(false);
        setLocalError(null);
      } catch (error) {
        setLocalError(String(error));
      }
    },
    [browserSessionId, sessionState.activeTabId]
  );

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!matchingHistory.length) return;
      event.preventDefault();
      setHistoryIndex(index => index < 0
        ? (event.key === 'ArrowDown' ? 0 : matchingHistory.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + matchingHistory.length) % matchingHistory.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void handleNavigate(matchingHistory[historyIndex]?.url ?? addressValue);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setAddressValue(nextDisplayValue);
      setAddressEditing(false);
      (event.target as HTMLInputElement).blur();
    }
  };

  const handleAddressChange = (value: string) => {
    setAddressValue(value);
    setHistoryIndex(-1);
    if (sessionState.activeTabId) {
      setAddressDrafts((prev) => ({ ...prev, [sessionState.activeTabId!]: value }));
    }
  };

  const handleBack = () => {
    if (!activeTab) return;
    window.electron.browser.goBack({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };
  const handleForward = () => {
    if (!activeTab) return;
    window.electron.browser.goForward({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };
  const handleReload = () => {
    if (!activeTab) return;
    window.electron.browser.reload({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };
  const handleCopyUrl = () => {
    if (!activeTab?.url) return;
    void navigator.clipboard.writeText(activeTab.url);
    toast.success('URL copied');
  };
  const handleOpenExternal = () => {
    if (!activeTab?.url) return;
    void window.electron.openExternalUrl(activeTab.url).then((result) => {
      if (!result.ok) toast.error(result.message || 'Unable to open in external browser');
    });
  };
  const zoomPercent = (!showStartPage && activeTab?.zoomPercent) || 100;
  // After a zoom change the address bar briefly expands to − 110% + so the change is visible and repeatable.
  const [zoomFlash, setZoomFlash] = useState(false);
  const [zoomHover, setZoomHover] = useState(false);
  const zoomTrackRef = useRef<{ tabId: string | null; percent: number }>({ tabId: null, percent: 100 });
  useEffect(() => {
    const tabId = activeTab?.id ?? null;
    const previous = zoomTrackRef.current;
    zoomTrackRef.current = { tabId, percent: zoomPercent };
    if (previous.tabId !== tabId || previous.percent === zoomPercent) return;
    setZoomFlash(true);
    const timer = window.setTimeout(() => setZoomFlash(false), ZOOM_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [activeTab?.id, zoomPercent]);
  const zoomExpanded = zoomFlash || zoomHover;
  const zoomControlVisible = !showStartPage && !addressEditing && (zoomPercent !== 100 || zoomFlash);
  const zoomReserve = zoomControlVisible ? (zoomExpanded ? ZOOM_RESERVE_EXPANDED_PX : ZOOM_RESERVE_COMPACT_PX) : null;
  useEffect(() => {
    if (!zoomControlVisible) setZoomHover(false);
  }, [zoomControlVisible]);
  // The open menu covers a frozen snapshot, so zooming from it closes it to show the page.
  const handleMenuZoom = (action: BrowserZoomAction) => {
    handleZoom(action);
    setMenuOpen(false);
  };
  const handleZoom = (action: BrowserZoomAction) => {
    if (!activeTab) return;
    window.electron.browser.zoom({ sessionId: browserSessionId, tabId: activeTab.id, action }).catch(() => {});
  };
  const handleOpenDevTools = () => {
    if (!activeTab) return;
    window.electron.browser
      .openDevTools({ sessionId: browserSessionId, tabId: activeTab.id })
      .catch(() => {});
  };

  const handleCaptureScreenshot = async () => {
    if (!activeTab || screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const result = await window.electron.browser.capture({
        sessionId: browserSessionId,
        tabId: activeTab.id,
      });
      if (!result.ok || !result.base64) {
        toast.error(result.message || 'Failed to capture screenshot');
        return;
      }
      const bytes = base64ToBytes(result.base64);
      const mimeType = result.mimeType || 'image/png';
      const attachment = (await window.electron.createInlineImageAttachment(
        mimeType,
        bytes
      )) as Attachment | null;
      if (!attachment) {
        toast.error('Failed to create screenshot attachment');
        return;
      }
      const note = `Screenshot of [${result.pageTitle || result.pageUrl || activeTab.title}](${
        result.pageUrl || activeTab.url
      })`;
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text: note,
        attachments: [attachment],
        mode: 'append',
        source: 'browser:screenshot',
      });
      toast.success('Screenshot added to chat');
    } catch (error) {
      toast.error(`Failed to capture screenshot: ${error}`);
    } finally {
      setScreenshotBusy(false);
    }
  };

  const handleReadPage = async () => {
    if (!activeTab || readoutBusy) return;
    setReadoutBusy(true);
    try {
      const result = await window.electron.browser.readPage({
        sessionId: browserSessionId,
        tabId: activeTab.id,
      });
      if (!result.ok) {
        toast.error(result.message || 'Failed to read this page');
        return;
      }
      const text = formatReadoutText(result);
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text,
        mode: 'append',
        source: 'browser:readout',
      });
      toast.success('Page content sent to chat');
    } catch (error) {
      toast.error(`Failed to read page: ${error}`);
    } finally {
      setReadoutBusy(false);
    }
  };

  // ===== 面板尺寸拖拽 =====
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - event.clientX;
      const next = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, startWidthRef.current + delta)
      );
      onWidthChange(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [isResizing, onWidthChange]);

  // Esc exits fullscreen. Only binds when in fullscreen so we don't swallow
  // Escape elsewhere (address bar blur, modal close, etc.).
  useEffect(() => {
    if (!isFullscreen || embedded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        onToggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, isFullscreen, onToggleFullscreen]);

  // ===== Render =====
  return (
    <div
      className={
        embedded
          ? `absolute inset-0 min-h-0 min-w-0 bg-[var(--bg-primary)] ${
              collapsed ? 'hidden' : 'flex flex-col'
            }`
          : `relative flex h-full flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] transition-[width,opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isFullscreen ? 'flex-1 min-w-0' : 'flex-shrink-0'
            } ${collapsed && !isFullscreen ? 'pointer-events-none' : ''}`
      }
      style={
        embedded
          ? undefined
          : isFullscreen
          ? {
              width: 'auto',
              opacity: 1,
              transform: 'translateX(0)',
              borderLeftWidth: 1,
            }
          : {
              width: collapsed ? 0 : width,
              opacity: collapsed ? 0 : 1,
              transform: collapsed ? 'translateX(18px)' : 'translateX(0)',
              borderLeftWidth: collapsed ? 0 : 1,
            }
      }
      aria-hidden={collapsed && !isFullscreen}
      onKeyDown={handlePanelKeyDown}
    >
      {!embedded && !collapsed && !isFullscreen && (
        <div
          className="group absolute left-0 top-0 bottom-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
        </div>
      )}

      {/* Top drag strip */}
      {!embedded ? (
        <div
          className="drag-region flex-shrink-0"
          style={{ height: topInset > 0 ? topInset : 32 }}
        />
      ) : null}

      {/* Chrome */}
      <div className="no-drag relative flex-shrink-0">
        <div className="grid h-11 grid-cols-[minmax(max-content,1fr)_minmax(0,770px)_minmax(max-content,1fr)] items-center gap-1.5 px-2">
          <div className="flex items-center gap-1.5 justify-self-start">
            {sessionState.agentActive ? (
              <span
                className="inline-flex h-7 items-center gap-1.5 rounded-[10px] bg-[var(--accent-light)] px-2 text-[11px] font-medium text-[var(--accent)]"
                title="An agent is driving this browser panel"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                </span>
                Agent
              </span>
            ) : null}
            <div role="group" aria-label="Navigation" className="flex items-center gap-px">
              <button
                type="button"
                onClick={handleBack}
                disabled={!activeTab?.canGoBack}
                className={`${TOOLBAR_BUTTON_CLASS} rounded-l-[10px]`}
                title="Back"
                aria-label="Back"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleForward}
                disabled={!activeTab?.canGoForward}
                className={TOOLBAR_BUTTON_CLASS}
                title="Forward"
                aria-label="Forward"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleReload}
                disabled={!activeTab || showStartPage}
                className={`${TOOLBAR_BUTTON_CLASS} rounded-r-[10px]`}
                title="Reload"
                aria-label="Reload"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="relative min-w-0">
            <div
              className={`relative flex h-7 cursor-text items-center rounded-[10px] transition-[background-color,box-shadow] duration-150 ${
                addressEditing
                  ? 'bg-[var(--sidebar-item-hover)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]'
                  : 'hover:bg-[var(--sidebar-item-hover)]'
              }`}
            >
              <input
                ref={addressInputRef}
                type="text"
                spellCheck={false}
                value={addressEditing ? addressValue : browserAddressRestingValue(addressValue)}
                onChange={(e) => handleAddressChange(e.target.value)}
                onFocus={(e) => {
                  setAddressEditing(true);
                  setHistoryIndex(-1);
                  e.currentTarget.select();
                  void freezePage();
                }}
                onBlur={() => {
                  window.setTimeout(() => setAddressEditing(false), 100);
                }}
                onKeyDown={handleAddressKeyDown}
                aria-label="Search or enter a URL"
                role="combobox" aria-expanded={historyOpen} aria-controls={historyOpen ? `browser-history-${browserSessionId}` : undefined}
                aria-autocomplete="list" aria-activedescendant={historyOpen && historyIndex >= 0 ? `browser-history-${browserSessionId}-${historyIndex}` : undefined}
                placeholder="Search or enter a URL"
                style={zoomReserve ? { paddingLeft: zoomReserve, paddingRight: zoomReserve } : undefined}
                className={`h-full w-full min-w-0 bg-transparent px-3 text-[12px] leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] ${
                  addressEditing ? 'text-left' : 'bubble-browser-address-resting text-center'
                }`}
              />
              {zoomControlVisible ? (
                <div
                  data-browser-zoom-control
                  data-expanded={zoomExpanded ? 'true' : 'false'}
                  onMouseEnter={() => setZoomHover(true)}
                  onMouseLeave={() => setZoomHover(false)}
                  className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-[7px] bg-[var(--sidebar-item-hover)] text-[11px] font-medium tabular-nums text-[var(--text-secondary)]"
                >
                  {zoomExpanded ? (
                    <button type="button" aria-label="Zoom out" onClick={() => handleZoom('out')} className="flex h-5 w-5 items-center justify-center rounded-[6px] hover:bg-[var(--sidebar-item-active)] hover:text-[var(--text-primary)]">
                      <Minus className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleZoom('reset')}
                    data-browser-zoom-indicator
                    className="h-5 min-w-9 rounded-[6px] px-1.5 transition-colors hover:bg-[var(--sidebar-item-active)] hover:text-[var(--text-primary)]"
                    title="Reset zoom (⌘0)"
                    aria-label={`Zoom ${zoomPercent}%, reset to 100%`}
                  >
                    {zoomPercent}%
                  </button>
                  {zoomExpanded ? (
                    <button type="button" aria-label="Zoom in" onClick={() => handleZoom('in')} className="flex h-5 w-5 items-center justify-center rounded-[6px] hover:bg-[var(--sidebar-item-active)] hover:text-[var(--text-primary)]">
                      <Plus className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {historyOpen ? <div role="listbox" id={`browser-history-${browserSessionId}`} aria-label="Recent pages" className="bubble-address-history">
              {matchingHistory.map((item, index) => <button key={item.url} id={`browser-history-${browserSessionId}-${index}`} role="option" aria-selected={historyIndex === index} type="button"
                onMouseDown={event => event.preventDefault()} onClick={() => void handleNavigate(item.url)}>
                <span>{item.title || item.url}</span><small>{item.url}</small>
              </button>)}
            </div> : null}
          </div>

          <div className="flex items-center gap-0.5 justify-self-end">
            <button
              type="button"
              onClick={() => void toggleDesignMode()}
              disabled={!activeTab}
              className={`${TOOLBAR_BUTTON_CLASS} rounded-[10px] ${
                designTarget
                  ? 'bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] !text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]'
                  : ''
              }`}
              title={designTarget ? 'Exit design mode' : 'Design mode: click an element, describe the change, send it to the agent'}
              aria-label="Toggle design mode"
              aria-pressed={!!designTarget}
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleCaptureScreenshot}
              disabled={!activeTab || screenshotBusy}
              className={`${TOOLBAR_BUTTON_CLASS} rounded-[10px]`}
              title="Screenshot to chat"
              aria-label="Screenshot to chat"
            >
              {screenshotBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
            </button>
            <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={`${TOOLBAR_BUTTON_CLASS} rounded-[10px] data-[popup-open]:bg-[var(--sidebar-item-hover)] data-[popup-open]:text-[var(--text-primary)]`}
                  title="Browser actions"
                  aria-label="Browser actions"
                  data-browser-actions-trigger
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-[220px]" data-browser-actions-menu>
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={showStartPage || readoutBusy} onClick={() => void handleReadPage()}>
                  <FileText className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Send page content to chat
                </DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={showStartPage} onClick={handleCopyUrl}>
                  <Copy className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Copy URL
                </DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={showStartPage} onClick={handleOpenExternal}>
                  <ExternalLink className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Open in external browser
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={!findTabId} onClick={openFind}>
                  <Search className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Find in page
                  <DropdownMenuShortcut>⌘F</DropdownMenuShortcut>
                </DropdownMenuItem>
                <div className="flex items-center gap-2.5 rounded-lg px-3 py-1 text-[13px]" data-browser-zoom-controls>
                  <ZoomIn className="h-3.5 w-3.5 text-[var(--text-secondary)]" aria-hidden="true" />
                  <span className="flex-1">Zoom</span>
                  <div className="flex items-center rounded-[8px] bg-[var(--sidebar-item-hover)] p-0.5">
                    <button type="button" aria-label="Zoom out" disabled={showStartPage} onClick={() => handleMenuZoom('out')} className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--popover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40">
                      <Minus className="h-3 w-3" />
                    </button>
                    <button type="button" aria-label="Reset zoom" disabled={showStartPage} onClick={() => handleMenuZoom('reset')} className="h-6 min-w-11 rounded-[6px] px-1 text-[12px] tabular-nums text-[var(--text-primary)] hover:bg-[var(--popover-bg)] disabled:opacity-40">
                      {zoomPercent}%
                    </button>
                    <button type="button" aria-label="Zoom in" disabled={showStartPage} onClick={() => handleMenuZoom('in')} className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--popover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40">
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={() => setImportOpen(true)}>
                  <FileImport className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Import from browser…
                </DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={() => setClearDataOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Clear browsing data…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={!activeTab} onClick={handleOpenDevTools}>
                  <Code2 className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  Open DevTools
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div aria-hidden="true" className="bubble-browser-progress" data-loading={activeTab?.isLoading ? 'true' : 'false'} />
      </div>

      {findOpen && findTabId ? (
        <BrowserFindBar
          inputRef={findInputRef}
          query={findQuery}
          matches={activeTab?.findMatches}
          onQueryChange={setFindQuery}
          onNext={() => runFind({ forward: true, next: true })}
          onPrevious={() => runFind({ forward: false, next: true })}
          onClose={closeFind}
        />
      ) : null}
      {importSources.length > 0 && !importPromptDismissed ? (
        <BrowserImportBanner
          sources={importSources}
          onImport={() => void freezePage().then(() => setImportOpen(true))}
          onDismiss={dismissImportPrompt}
        />
      ) : null}
      <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleImported} />
      <BrowserClearDataDialog open={clearDataOpen} onOpenChange={setClearDataOpen} />

      {/* Viewport row: native WebContentsView mirror + (optional) design drawer.
          The drawer shrinks the viewport div; the ResizeObserver above pushes
          the smaller bounds to the main process automatically. */}
      <div className="flex min-h-0 flex-1" style={{ marginBottom: bottomInset }}>
        <div className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
          <div ref={viewportRef} className="absolute inset-0" />
          {frozenPage?.src && !showStartPage && !loadError ? (
            <img
              src={frozenPage.src}
              alt=""
              aria-hidden="true"
              draggable={false}
              data-browser-page-snapshot
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-left-top"
            />
          ) : null}
          {showStartPage ? <BrowserStartPage history={history} onNavigate={url => void handleNavigate(url)} onOpenTool={tool => useAppStore.getState().openRightUtilityTab(tool)} /> : null}
          {loadError && activeTab ? <BrowserLoadErrorPage message={loadError} errorCode={activeTab.lastErrorCode} url={activeTab.url} onRetry={() => void handleNavigate(activeTab.url)} /> : null}
          {!showStartPage && !loadError && chromeStatus && (
            <div
              className={`pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border px-2 py-1 text-[11px] ${
                chromeStatus.tone === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-400'
                  : 'border-[var(--border)] bg-[var(--bg-secondary)]/80 text-[var(--text-secondary)]'
              }`}
            >
              {chromeStatus.label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function formatReadoutText(result: BrowserReadoutResult): string {
  const lines: string[] = [];
  lines.push(`Context from [${result.title || result.url || 'page'}](${result.url || ''})`);
  if (result.selection && result.selection.trim().length > 0) {
    lines.push('\nSelected text:');
    lines.push(result.selection.trim());
  }
  if (result.text && result.text.trim().length > 0) {
    const body = result.text.trim().slice(0, READOUT_TEXT_CHAR_LIMIT);
    lines.push('\nPage text:');
    lines.push(body);
    if (result.text.length > READOUT_TEXT_CHAR_LIMIT) {
      lines.push(`\n(Truncated to first ${READOUT_TEXT_CHAR_LIMIT} characters)`);
    }
  }
  if (result.links && result.links.length > 0) {
    const items = result.links.slice(0, READOUT_LINK_LIMIT);
    lines.push('\nTop links:');
    for (const link of items) {
      lines.push(`- [${link.text.trim() || link.url}](${link.url})`);
    }
  }
  return lines.join('\n');
}
