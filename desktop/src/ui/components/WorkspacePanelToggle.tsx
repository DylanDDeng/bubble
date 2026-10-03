import { useState } from 'react';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './ui/context-menu';
import { useBrowserNativeOverlayRegistration } from './browser/browser-native-overlay';
import { RightPanelToggleIcon } from './RightPanelToggleIcon';
import { ExpandDiagonal, Plus } from './icons';

export function WorkspacePanelToggle({ active, tabCount, onToggle, onNewTab }: {
  active: boolean;
  tabCount?: number;
  onToggle: () => void;
  onNewTab: (fullView: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useBrowserNativeOverlayRegistration(menuOpen);
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger render={
        <button type="button" onClick={onToggle}
          className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          title={active ? 'Hide tabs · Right-click for new tab options' : 'Show tabs · Right-click for new tab options'}
          aria-label={active ? 'Hide tabs' : 'Show tabs'} aria-expanded={active} aria-pressed={active}>
          {!tabCount ? <RightPanelToggleIcon /> : <span aria-hidden="true" className="bubble-tab-count">{tabCount}</span>}
        </button>
      } />
      <ContextMenuContent className="min-w-[208px]">
        <ContextMenuItem onClick={() => onNewTab(false)}><Plus className="mr-2 h-3.5 w-3.5" />New tab</ContextMenuItem>
        <ContextMenuItem onClick={() => onNewTab(true)}><ExpandDiagonal className="mr-2 h-3.5 w-3.5" />New tab in full view</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
