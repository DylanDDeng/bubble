import type { ReactNode, Ref } from 'react';
import { CollapseDiagonal, ExpandDiagonal, FolderClosed, MoreHorizontal } from './icons';
import { WorkspacePanelToggle } from './WorkspacePanelToggle';

/** Window-level controls stay in place as chat and tool panes resize below. */
export function WorkspaceHeader({ title, actions, environment, fullView, tabsVisible, tabCount, onToggleFullView, onToggleTabs, onNewTab, tabSlotRef, chatSelected = false, conversationTitle = 'Chat', onSelectChat }: {
  chatSelected?: boolean;
  conversationTitle?: string;
  onSelectChat?: () => void;
  tabSlotRef?: Ref<HTMLDivElement>;
  title: ReactNode;
  actions: ReactNode;
  environment: ReactNode;
  fullView: boolean;
  tabsVisible: boolean;
  tabCount: number;
  onToggleFullView: () => void;
  onToggleTabs: () => void;
  onNewTab: (fullView: boolean) => void;
}) {
  return <header data-workspace-header data-tools-visible={tabsVisible || undefined} data-full-view={fullView || undefined} className="bubble-workspace-header">
    <div className="bubble-titlebar-drag-area drag-region" aria-hidden="true" />
    <div className="bubble-workspace-header-chat" data-conversation-selected={fullView && chatSelected || undefined}>
      {fullView ? <button type="button" role="tab" aria-label="Show conversation" aria-selected={chatSelected} onClick={onSelectChat} className="bubble-full-view-conversation-tab no-drag"><FolderClosed className="h-3.5 w-3.5 shrink-0" /><span>{conversationTitle}</span></button> : <div className="bubble-workspace-header-title"><FolderClosed className="h-3.5 w-3.5 shrink-0" /><div className="bubble-header-title-label">{title}</div></div>}
      <div className="bubble-workspace-header-actions no-drag" role="toolbar" aria-label="Conversation controls">
        {actions ?? <button type="button" disabled className="bubble-header-button disabled:opacity-40" aria-label="Conversation actions"><MoreHorizontal className="h-4 w-4" /></button>}
        {!fullView && environment}
      </div>
    </div>
    <div className="bubble-workspace-header-tools">
      <div ref={tabSlotRef} className="bubble-workspace-header-tabs" hidden={!tabsVisible} />
      <div className="bubble-workspace-header-actions no-drag" role="toolbar" aria-label="Workspace controls">
      {fullView && environment}
      <button type="button" className="bubble-header-button" title={fullView ? 'Exit full view' : 'Open full view'} aria-label={fullView ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullView} onClick={onToggleFullView}>
        {fullView ? <CollapseDiagonal className="h-3.5 w-3.5" /> : <ExpandDiagonal className="h-3.5 w-3.5" />}
      </button>
      <WorkspacePanelToggle active={tabsVisible} tabCount={tabCount} onToggle={onToggleTabs} onNewTab={onNewTab} />
      </div>
    </div>
  </header>;
}
