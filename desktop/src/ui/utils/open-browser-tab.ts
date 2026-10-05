import type { ProjectUtilityPanelTarget } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useBrowserStateStore } from '../store/useBrowserStateStore';
import { getBrowserUtilitySessionId } from './browser-utility';
import { createBrowserTabId, isRightUtilityBrowserTab } from './right-utility-tabs';

/** The page a browser utility tab currently shows, from the panel's persisted state. */
export function browserTabPage(target: ProjectUtilityPanelTarget): { sessionId: string; tabId: string | null; url: string | null } {
  const sessionId = getBrowserUtilitySessionId(useAppStore.getState().activeSessionId, target);
  const state = useBrowserStateStore.getState().sessionStatesBySessionId[sessionId];
  const tab = state?.tabs.find((item) => item.id === state.activeTabId) ?? state?.tabs[0];
  const url = tab?.url && /^https?:\/\//i.test(tab.url) ? tab.url : null;
  return { sessionId, tabId: tab?.id ?? null, url };
}

/** The utility tab hosting a given browser session (each browser tab owns one session). */
export function browserUtilityTabForSession(browserSessionId: string): ProjectUtilityPanelTarget | null {
  const { activeSessionId, rightUtilityTabs } = useAppStore.getState();
  return (
    rightUtilityTabs.find(
      (tab) => isRightUtilityBrowserTab(tab) && getBrowserUtilitySessionId(activeSessionId, tab) === browserSessionId
    ) ?? null
  );
}

/** Opens a browser tab after `after` (or at the end); with a URL, its session starts on that page. */
export function openBrowserTab({ url, after }: { url?: string | null; after?: ProjectUtilityPanelTarget | null }): void {
  const browserTabId = createBrowserTabId();
  if (url) {
    const sessionId = getBrowserUtilitySessionId(useAppStore.getState().activeSessionId, browserTabId);
    const seedTabId = `seed-${browserTabId}`;
    useBrowserStateStore.getState().upsertSessionState({
      sessionId,
      activeTabId: seedTabId,
      tabs: [{ id: seedTabId, url, title: url, faviconUrl: null }],
      updatedAt: Date.now(),
    });
  }
  useAppStore.getState().openRightUtilityTab('browser', { newTab: true, browserTabId, insertAfter: after ?? null });
}
