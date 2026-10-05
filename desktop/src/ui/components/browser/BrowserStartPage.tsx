import { FileDiff, FolderClosed, Globe, SquareTerminal, Palette, ShieldX, WifiOff, X } from '../icons';
import { describeBrowserLoadError } from './browser-load-error';
import type { BrowserHistoryEntry } from '../../store/useBrowserStateStore';
import type { BrowserImportSourceInfo } from '../../types';
import { BrowserDialogButton, BrowserSourceIcon } from './browser-dialog';

/** Offer to bring another browser's sign-ins over, until imported or dismissed. */
export function BrowserImportBanner({ sources, onImport, onDismiss }: {
  sources: BrowserImportSourceInfo[];
  onImport: () => void;
  onDismiss: () => void;
}) {
  const title = sources.length === 1 ? `Import data from ${sources[0].appName}` : 'Import data from your browser';
  return <div data-browser-import-banner className="flex min-h-14 w-full flex-shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--popover-bg)] py-2 pl-4 pr-2 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
    <div className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
      {sources.slice(0, 3).map(info => <span key={info.source} className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--popover-bg)]">
        <BrowserSourceIcon source={info.source} sources={sources} className="h-5 w-5" />
      </span>)}
    </div>
    <div className="min-w-40 flex-1">
      <div className="text-[13px] font-medium leading-5 text-[var(--text-primary)]">{title}</div>
      <div className="text-[12px] leading-4 text-[var(--text-secondary)]">Bring over your cookies to stay signed in to your sites</div>
    </div>
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <BrowserDialogButton size="toolbar" variant="secondary" onClick={onImport}>Import</BrowserDialogButton>
      <BrowserDialogButton size="toolbar" variant="ghost" className="w-7 px-0" aria-label="Dismiss browser data import banner" title="Dismiss" onClick={onDismiss}>
        <X className="h-3.5 w-3.5" />
      </BrowserDialogButton>
    </div>
  </div>;
}

export function BrowserStartPage({ history, onNavigate, onOpenTool }: {
  history: BrowserHistoryEntry[];
  onNavigate: (url: string) => void;
  onOpenTool: (tool: 'files' | 'review' | 'terminal' | 'design') => void;
}) {
  return <div className="bubble-browser-start" data-browser-start-page>
    <h2>Tools</h2>
    <div className="bubble-browser-tools">
      {([
        ['review', 'Changes', FileDiff], ['terminal', 'Terminal', SquareTerminal], ['files', 'Files', FolderClosed], ['design', 'Design', Palette],
      ] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-label={`Open ${label} panel`} onClick={() => onOpenTool(id)}><Icon className="h-4 w-4" />{label}</button>)}
    </div>
    {history.length > 0 ? <>
      <h2>Recent pages</h2>
      <div className="bubble-browser-recents">
        {history.slice(0, 4).map(item => <button key={item.url} type="button" title={item.url} onClick={() => onNavigate(item.url)}>
          <Globe className="h-6 w-6" strokeWidth={1.3} />
          <span>{item.title || item.url}</span>
        </button>)}
      </div>
    </> : null}
  </div>;
}

/** Electron renders failed loads as a blank page, so the panel shows the error itself. */
export function BrowserLoadErrorPage({ message, errorCode, url, onRetry }: {
  message: string;
  errorCode?: number | null;
  url: string;
  onRetry: () => void;
}) {
  const view = describeBrowserLoadError(errorCode, url, message);
  const Icon = view.kind === 'offline' ? WifiOff : view.kind === 'certificate' ? ShieldX : Globe;
  return <div className="bubble-browser-start bubble-browser-error" role="alert" data-browser-error-page data-error-kind={view.kind}>
    <div className="bubble-browser-error-body">
      <Icon className="h-9 w-9" strokeWidth={1.3} aria-hidden="true" />
      <h2>{view.heading}</h2>
      <p className="bubble-browser-error-summary" title={url}>{view.summary}</p>
      {view.tips.length ? <div className="bubble-browser-error-tips">
        <span>Try:</span>
        <ul>{view.tips.map(tip => <li key={tip.title}>{tip.title}{tip.body ? <small>{tip.body}</small> : null}</li>)}</ul>
      </div> : null}
      {view.codeName ? <code>{view.codeName}</code> : null}
      <BrowserDialogButton variant="primary" className="self-start" onClick={onRetry}>Reload</BrowserDialogButton>
    </div>
  </div>;
}
