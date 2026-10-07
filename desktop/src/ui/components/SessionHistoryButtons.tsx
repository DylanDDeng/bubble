import { useAppPreferences } from '../store/useAppPreferences';
import { shortcutLabel } from '../../shared/keyboard-shortcuts';
import { ArrowLeft, ArrowRight } from './icons';
import { useAppStore } from '../store/useAppStore';
import { useBoardStore } from '../store/useBoardStore';
import { canNavigateActiveTab, isTabViewVisitable, useTabsStore, type TabView } from '../store/useTabsStore';

/** Back from Settings returns to the view underneath; otherwise step the tab history. */
export function navigateBack(): void {
  const app = useAppStore.getState();
  if (app.showSettings) app.setShowSettings(false);
  else useTabsStore.getState().goBack();
}

/**
 * Back/Forward through the active tab's view history: sessions, the board,
 * a board task's detail page, and the other workspaces alike. Settings sit on
 * top of that history, so Back closes them and Forward has nowhere to go.
 */
export function SessionHistoryButtons({ className = '' }: { className?: string }) {
  const sessions = useAppStore((state) => state.sessions);
  const showSettings = useAppStore((state) => state.showSettings);
  const boardTasks = useBoardStore((state) => state.tasks);
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const goForward = useTabsStore((state) => state.goForward);

  const visitable = (view: TabView) => isTabViewVisitable(view, sessions, boardTasks);
  const canBack = showSettings || canNavigateActiveTab({ tabs, activeTabId }, -1, visitable);
  const canForward = !showSettings && canNavigateActiveTab({ tabs, activeTabId }, 1, visitable);
  const shortcuts = useAppPreferences(state => state.keyboardShortcuts);

  return (
    <div className={`no-drag flex shrink-0 items-center ${className}`.trim()}>
      <button
        type="button"
        disabled={!canBack}
        onClick={navigateBack}
        className={navButtonClass(canBack)}
        title={['Back', shortcutLabel('back', shortcuts)].filter(Boolean).join(' · ')}
        aria-label="Back"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.25} />
      </button>
      <button
        type="button"
        disabled={!canForward}
        onClick={() => goForward()}
        className={navButtonClass(canForward)}
        title={['Forward', shortcutLabel('forward', shortcuts)].filter(Boolean).join(' · ')}
        aria-label="Forward"
      >
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.25} />
      </button>
    </div>
  );
}

function navButtonClass(enabled: boolean): string {
  return `inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
    enabled
      ? 'text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-secondary)]'
      : 'cursor-default text-[var(--text-muted)] opacity-40'
  }`;
}
