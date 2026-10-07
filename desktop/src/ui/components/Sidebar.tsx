import { selectSidebarCollapsed, selectSidebarWidth, workspaceHasSidebarPanel } from '../utils/sidebar-width';
import { shortcutLabel } from '../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../store/useAppPreferences';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Bell,
  BellDot,
  Columns2,
  FolderOpen,
  GitPullRequest,
  MessageSquare,
  Script,
  Search,
  Settings,
  SquarePen,
  Clock,
} from './icons';
import { useAppStore } from '../store/useAppStore';
import { useBoardStore } from '../store/useBoardStore';
import { useTabsStore } from '../store/useTabsStore';
import { SidebarSearchPalette } from './search/SidebarSearchPalette';
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from './search/SidebarSearchPalette.logic';
import { FolderTreeView } from './FolderTreeView';
import { CappedScrollbar } from './CappedScrollbar';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { getMessageContentBlocks } from '../utils/message-content';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, WORKSPACE_RAIL_WIDTH } from '../utils/sidebar-width';
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

const SIDEBAR_TRIGGER_CLASS =
  'no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] active:scale-95';
function SidebarToggleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 ${className ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="16" x="3" y="4" rx="4" />
      <path d="M9 4v16" />
    </svg>
  );
}

function SidebarToggleButton({
  collapsed,
  className = '',
  onClick,
}: {
  collapsed: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-sidebar-trigger=""
      onClick={onClick}
      className={`${SIDEBAR_TRIGGER_CLASS} ${className}`}
      aria-controls="bubble-project-sidebar"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <SidebarToggleIcon />
      <span className="sr-only">Toggle sidebar</span>
    </button>
  );
}

export function SidebarHeaderTrigger({ className = '' }: { className?: string }) {
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const sidebarCollapsed = useAppStore(selectSidebarCollapsed);
  const hasSidebarPanel = useAppStore((state) => workspaceHasSidebarPanel(state.activeWorkspace));

  if (!hasSidebarPanel) return null;

  return (
    <SidebarToggleButton
      collapsed={sidebarCollapsed}
      className={className}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    />
  );
}

/** Workspace switcher; stays visible in Settings so the window frame never changes. */
export function WorkspaceRail() {
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const showSettings = useAppStore((state) => state.showSettings);
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const setChatSidebarView = useAppStore((state) => state.setChatSidebarView);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  // Badge = cards waiting for YOUR review, not the board's total size.
  const boardReviewCount = useBoardStore((state) =>
    Object.values(state.tasks).reduce((count, task) => count + (task.stage === 'review' ? 1 : 0), 0)
  );

  return (
    <nav className="bubble-workspace-rail z-30" aria-label="Workspaces">
      {([
        { id: 'chat', label: 'Chats', icon: MessageSquare },
        { id: 'automations', label: 'Automations', icon: Clock },
        { id: 'skills', label: 'Skill Library', icon: Script },
        { id: 'board', label: 'KanBan', icon: Columns2 },
        { id: 'prs', label: 'Pull Requests', icon: GitPullRequest },
      ] as const).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className="bubble-workspace-rail-button no-drag"
          aria-label={label}
          title={label}
          aria-pressed={!showSettings && activeWorkspace === id}
          onClick={() => {
            if (id === 'board' || activeWorkspace === 'board') {
              useTabsStore.getState().openWorkspace(id);
            } else {
              setActiveWorkspace(id);
            }
            setChatSidebarView('threads');
            setShowSettings(false);
          }}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
          {id === 'board' && boardReviewCount > 0 ? <span className="bubble-workspace-rail-dot" /> : null}
        </button>
      ))}
      <div className="flex-1" />
      <button type="button" className="bubble-workspace-rail-button no-drag" aria-label="Settings" title="Settings" aria-pressed={showSettings} onClick={() => setShowSettings(true)}>
        <Settings className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </button>
    </nav>
  );
}

export function Sidebar() {
  const {
    activeSessionId,
    projectCwd,
    activeChannelByProject,
    sessions,
    activeWorkspace,
    chatLayoutMode,
    setChatLayoutMode,
    setSidebarWidth,
    setChatSidebarView,
    setProjectCwd,
    setActiveChannelForProject,
    setActiveSession,
    setActiveWorkspace,
    setShowNewSession,
    setShowSettings,
    createDraftSession,
    searchPaletteOpen,
    setSearchPaletteOpen,
    sidebarActivityView,
    toggleSidebarActivityView,
  } = useAppStore();
  const sidebarCollapsed = useAppStore(selectSidebarCollapsed);
  const sidebarWidth = useAppStore(selectSidebarWidth);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarShellRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useAppReducedMotion();
  // Collapsing hides only the project panel; the workspace rail always stays.
  const closedWidth = WORKSPACE_RAIL_WIDTH;
  const expandedWidth = sidebarWidth + WORKSPACE_RAIL_WIDTH;
  const targetWidth = sidebarCollapsed ? closedWidth : expandedWidth;
  const animatedWidth = useMotionValue(targetWidth);
  // One motion value drives layout, content visibility and titlebar clearance.
  // Keep it alive across toggles so a reversal starts at the current position.
  const syncSidebarMotion = useCallback((width: number) => {
    const shell = sidebarShellRef.current?.closest<HTMLElement>('.aegis-window-shell');
    shell?.style.setProperty('--bubble-sidebar-width', `${Math.max(0, width)}px`);
    shell?.style.setProperty('--bubble-sidebar-opacity', `${Math.max(0, Math.min(1, (width - closedWidth) / (expandedWidth - closedWidth)))}`);
  }, [closedWidth, expandedWidth]);
  useMotionValueEvent(animatedWidth, 'change', syncSidebarMotion);
  useLayoutEffect(() => {
    syncSidebarMotion(animatedWidth.get());
    if (isSidebarResizing || reducedMotion) {
      animatedWidth.jump(targetWidth);
      return;
    }
    const animation = animate(animatedWidth, targetWidth, { type: 'spring', duration: 0.3, bounce: 0.1 });
    return () => animation.stop();
  }, [animatedWidth, targetWidth, isSidebarResizing, reducedMotion, syncSidebarMotion]);
  const sidebarResizingRef = useRef(false);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const newThreadCwd = activeSession?.cwd || projectCwd;
  // runtimeNotice = 任务在后台结束但用户还没点开看（查看后自动清除），
  // 铃铛上的小圆点就是这个未读信号，和 Codex 的 activity badge 一致。
  const hasUnviewedFinishedSession = Object.values(sessions).some((session) =>
    Boolean(session.runtimeNotice)
  );

  const getActiveChannelIdForProject = (cwd?: string | null) => {
    const key = cwd?.trim() || '__no_project__';
    return activeChannelByProject[key] || DEFAULT_WORKSPACE_CHANNEL_ID;
  };

  const finishSidebarResize = () => {
    if (!sidebarResizingRef.current) return;
    sidebarResizingRef.current = false;
    setIsSidebarResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const handleSidebarResizeMove = (clientX: number) => {
    if (!sidebarResizingRef.current) return;
    const delta = clientX - startXRef.current;
    const nextWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, startWidthRef.current + delta)
    );
    setSidebarWidth(nextWidth);
  };

  const handleSidebarResizeStart = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    sidebarResizingRef.current = true;
    setIsSidebarResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isSidebarResizing) return;

    const handleWindowBlur = () => finishSidebarResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleProjectFolderSelect = async () => {
    const selected = await window.electron.selectDirectory();
    if (!selected) return;
    setProjectCwd(selected);
    setActiveChannelForProject(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
    setShowSettings(false);
    createDraftSession(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
  };

  const shortcuts = useAppPreferences(state => state.keyboardShortcuts);
  const paletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: 'new-thread',
        label: 'New Task',
        description: 'Start a new conversation',
        keywords: ['create', 'conversation', 'chat', 'session', 'thread', 'task'],
        shortcutLabel: shortcutLabel('newTask', shortcuts),
      },
      {
        id: 'open-project',
        label: 'Open Project Folder',
        description: 'Pick a working directory for a new thread',
        keywords: ['folder', 'cwd', 'directory'],
      },
      {
        id: 'switch-chat',
        label: 'Go to Threads',
        description: 'Show the threads workspace',
        keywords: ['chat', 'sessions'],
      },
      {
        id: 'switch-automations',
        label: 'Go to Automations',
        description: 'Manage scheduled project workflows',
        keywords: ['automation', 'schedule', 'cron', 'workflow'],
      },
      {
        id: 'switch-prs',
        label: 'Go to Pull Requests',
        description: 'Review and merge your GitHub pull requests',
        keywords: ['pr', 'pull request', 'github', 'merge', 'review'],
      },
      {
        id: 'switch-skills',
        label: 'Go to Skills',
        description: 'Browse skills',
        keywords: ['skills', 'agents'],
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Open application settings',
        keywords: ['preferences', 'config'],
      },
    ],
    [shortcuts]
  );

  const visibleSessions = useMemo(
    () =>
      Object.values(sessions).filter(
        (session) =>
          !session.hiddenFromThreads &&
          session.scope !== 'dm'
      ),
    [sessions]
  );

  const paletteProjects = useMemo<SidebarSearchProject[]>(() => {
    const map = new Map<string, SidebarSearchProject>();
    for (const session of visibleSessions) {
      const cwd = session.cwd?.trim();
      if (!cwd) continue;
      const existing = map.get(cwd);
      if (existing) {
        existing.sessionCount += 1;
        if (session.updatedAt > existing.lastUpdatedAt) {
          existing.lastUpdatedAt = session.updatedAt;
        }
      } else {
        const parts = cwd.split('/').filter(Boolean);
        map.set(cwd, {
          id: cwd,
          name: parts[parts.length - 1] || cwd,
          cwd,
          sessionCount: 1,
          lastUpdatedAt: session.updatedAt,
        });
      }
    }
    return Array.from(map.values());
  }, [visibleSessions]);

  const paletteThreads = useMemo<SidebarSearchThread[]>(() => {
    return visibleSessions.map((session) => {
      const cwd = session.cwd?.trim() || null;
      const projectName = cwd
        ? cwd.split('/').filter(Boolean).pop() || cwd
        : 'No Project';

      // Only hydrated sessions have message content available in memory.
      // For others we still match title / project — consistent with the
      // lightweight, in-memory-only philosophy of the palette.
      const messages: { text: string }[] = [];
      if (session.hydrated) {
        for (const message of session.messages) {
          if (message.type === 'user_prompt') {
            messages.push({ text: message.prompt });
          } else if (message.type === 'assistant' || message.type === 'user') {
            const text = getMessageContentBlocks(message)
              .map((block) => {
                if (block.type === 'text') return block.text;
                if (block.type === 'thinking') return block.thinking;
                return '';
              })
              .filter(Boolean)
              .join(' ');
            if (text) messages.push({ text });
          }
        }
      }

      return {
        id: session.id,
        title: session.title,
        projectName,
        projectCwd: cwd,
        provider: session.provider,
        updatedAt: session.updatedAt,
        messages,
      };
    });
  }, [visibleSessions]);

  const runPaletteAction = (actionId: string) => {
    switch (actionId) {
      case 'new-thread':
        setShowSettings(false);
        createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
        break;
      case 'open-project':
        void handleProjectFolderSelect();
        break;
      case 'switch-chat':
        setActiveWorkspace('chat');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-automations':
        setActiveWorkspace('automations');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-prs':
        setActiveWorkspace('prs');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-skills':
        setActiveWorkspace('skills');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'settings':
        setShowSettings(true);
        break;
    }
  };

  const openThreadFromPalette = (sessionId: string) => {
    setShowSettings(false);
    // 不要 setChatLayoutMode('single')：那会把整棵平铺树坍缩成单 leaf。
    // setActiveSession 会把会话装入当前聚焦 leaf，保留用户的分屏布局。
    setActiveSession(sessionId);
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
  };

  const openProjectFromPalette = (projectId: string) => {
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
    setProjectCwd(projectId);
    setShowSettings(false);
  };

  return (
    <>
      {isSidebarResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handleSidebarResizeMove(event.clientX)}
          onMouseUp={finishSidebarResize}
        />
      )}

      <div ref={sidebarShellRef} className="aegis-sidebar relative flex h-full min-h-0 flex-shrink-0 self-stretch select-none">
        <div className="absolute inset-y-0 left-0 z-30 w-11">
          <WorkspaceRail />
        </div>
        <div
          className="relative flex h-full min-h-0 flex-shrink-0 self-stretch overflow-hidden"
          style={{ width: 'var(--bubble-sidebar-width)' }}
        >
          <div
            id="bubble-project-sidebar"
            className={`relative h-full flex min-h-0 flex-col overflow-hidden bg-[var(--app-sidebar-surface)] ${sidebarCollapsed ? 'pointer-events-none' : ''}`}
            style={{ opacity: 'var(--bubble-sidebar-opacity)', width: expandedWidth, minWidth: expandedWidth, backdropFilter: 'var(--app-sidebar-backdrop-filter)', WebkitBackdropFilter: 'var(--app-sidebar-backdrop-filter)' }}
            aria-hidden={sidebarCollapsed}
            inert={sidebarCollapsed}
          >
            <div className="drag-region h-10 flex-shrink-0 ml-[176px]" aria-hidden="true" />

            <div className="bubble-sidebar-content flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <div className="aegis-sidebar-brand font-semibold leading-none tracking-[-0.04em] text-[var(--text-primary)]">
                  Bubble
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setSearchPaletteOpen(true)}
                    className={SIDEBAR_TRIGGER_CLASS}
                    aria-label="Search"
                    title="Search"
                  >
                    <Search className="h-4 w-4" strokeWidth={1.4} />
                  </button>
                  <button
                    type="button"
                    onClick={toggleSidebarActivityView}
                    className={`no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 ${
                      sidebarActivityView
                        ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                    }`}
                    aria-pressed={sidebarActivityView}
                    aria-label={sidebarActivityView ? 'Turn off activity view' : 'Turn on activity view'}
                    title={sidebarActivityView ? 'Turn off activity view' : 'Turn on activity view'}
                  >
                    {hasUnviewedFinishedSession ? (
                      <BellDot className="h-4 w-4" strokeWidth={1.4} />
                    ) : (
                      <Bell className="h-4 w-4" strokeWidth={1.4} />
                    )}
                  </button>
                </div>
              </div>

              <div className="px-2 pt-1">
                <SidebarNavRow
                  icon={<SquarePen className="h-[15px] w-[15px]" />}
                  label="New Task"
                  onClick={() => {
                    setShowSettings(false);
                    setActiveWorkspace('chat');
                    setChatSidebarView('threads');
                    createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
                  }}
                />
              </div>

              <div className="relative min-h-0 flex-1">
                <div
                  ref={sidebarScrollRef}
                  className="sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden px-2"
                  data-sidebar-scroll-region
                >
                  <div className="pt-3">
                    <FolderTreeView
                      onSessionClick={(sessionId, options) => {
                        setShowSettings(false);
                        setChatLayoutMode(
                          options?.preserveSplit || chatLayoutMode === 'split' ? 'split' : 'single'
                        );
                        setActiveSession(sessionId);
                        setShowNewSession(false);
                        setActiveWorkspace('chat');
                        setChatSidebarView('threads');
                      }}
                      onSelectProjectFolder={handleProjectFolderSelect}
                      projectCwd={projectCwd}
                      onNewSessionForProject={(nextCwd, channelId) => {
                        const nextChannelId = channelId || getActiveChannelIdForProject(nextCwd);
                        setProjectCwd(nextCwd);
                        setActiveChannelForProject(nextCwd, nextChannelId);
                        setShowSettings(false);
                        setChatSidebarView('threads');
                        createDraftSession(nextCwd, nextChannelId);
                      }}
                    />
                  </div>
                </div>

                <CappedScrollbar scrollRef={sidebarScrollRef} />
              </div>

            </div>
          </div>

          {!sidebarCollapsed ? (
            <div
              className="group absolute right-0 top-0 bottom-0 w-3 translate-x-1/2 cursor-col-resize no-drag"
              onMouseDown={handleSidebarResizeStart}
            >
              <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
            </div>
          ) : null}
        </div>
      </div>

      <SidebarSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        actions={paletteActions}
        projects={paletteProjects}
        threads={paletteThreads}
        onRunAction={runPaletteAction}
        onOpenProject={openProjectFromPalette}
        onOpenThread={openThreadFromPalette}
      />
    </>
  );
}

function SidebarNavRow({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  /** Small trailing count (hidden when 0), e.g. Board cards waiting for review. */
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        onClick();
        (e.currentTarget as HTMLButtonElement).blur();
      }}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left no-drag transition-colors duration-150 ${
        active
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      aria-label={label}
    >
      <span className="flex h-4 w-4 items-center justify-center text-[var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-normal">{label}</span>
      {badge ? (
        <span className="rounded-full bg-[var(--sidebar-segment-bg)] px-1.5 text-[11px] leading-[16px] text-[var(--text-muted)]">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
