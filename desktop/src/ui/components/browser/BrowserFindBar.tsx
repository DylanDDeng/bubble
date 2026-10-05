import type { RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from '../icons';
import { BrowserDialogButton } from './browser-dialog';
import { isImeComposing } from './BrowserPanel.logic';

/** Find-in-page strip under the toolbar; the native page view paints above any floating DOM. */
export function BrowserFindBar({
  inputRef,
  query,
  matches,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matches: { active: number; total: number } | null | undefined;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const hasMatches = !!matches && matches.total > 0;
  const count = !query ? '' : !matches ? '' : hasMatches ? `${matches.active} of ${matches.total}` : 'No results';
  return (
    <div data-browser-find-bar className="flex h-10 w-full flex-shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--popover-bg)] pl-3 pr-2">
      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-[var(--sidebar-item-hover)] px-2.5 focus-within:ring-1 focus-within:ring-inset focus-within:ring-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            const primary = event.metaKey || event.ctrlKey;
            if (event.key === 'Enter' || (primary && event.key.toLowerCase() === 'g')) {
              event.preventDefault();
              if (event.shiftKey) onPrevious();
              else onNext();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (primary && event.key.toLowerCase() === 'f') {
              event.preventDefault();
              event.currentTarget.select();
            }
          }}
          placeholder="Find in page"
          aria-label="Find in page"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <span aria-live="polite" className={`shrink-0 text-[11px] tabular-nums ${query && matches && !hasMatches ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>
          {count}
        </span>
      </div>
      <BrowserDialogButton size="toolbar" variant="ghost" className="w-7 px-0" aria-label="Previous match" title="Previous match (⇧↩)" disabled={!hasMatches} onClick={onPrevious}>
        <ChevronUp className="h-3.5 w-3.5" />
      </BrowserDialogButton>
      <BrowserDialogButton size="toolbar" variant="ghost" className="w-7 px-0" aria-label="Next match" title="Next match (↩)" disabled={!hasMatches} onClick={onNext}>
        <ChevronDown className="h-3.5 w-3.5" />
      </BrowserDialogButton>
      <BrowserDialogButton size="toolbar" variant="ghost" className="w-7 px-0" aria-label="Close find bar" title="Close (Esc)" onClick={onClose}>
        <X className="h-3.5 w-3.5" />
      </BrowserDialogButton>
    </div>
  );
}
