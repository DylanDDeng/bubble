import { FileDiff, FolderClosed, Globe, SquareTerminal } from '../icons';
import type { BrowserHistoryEntry } from '../../store/useBrowserStateStore';

export function BrowserStartPage({ history, onNavigate, onOpenTool }: {
  history: BrowserHistoryEntry[];
  onNavigate: (url: string) => void;
  onOpenTool: (tool: 'files' | 'review' | 'terminal') => void;
}) {
  return <div className="bubble-browser-start" data-browser-start-page>
    <h2>Tools</h2>
    <div className="bubble-browser-tools">
      {([
        ['review', 'Changes', FileDiff], ['terminal', 'Terminal', SquareTerminal], ['files', 'Files', FolderClosed],
      ] as const).map(([id, label, Icon]) => <button key={id} type="button" onClick={() => onOpenTool(id)}><Icon className="h-4 w-4" />{label}</button>)}
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
