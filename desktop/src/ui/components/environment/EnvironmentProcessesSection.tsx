import { useEffect, useState } from 'react';
import type { TerminalProcessSummary } from '../../../shared/terminal';
import { SquareTerminal } from '../icons';

/** Read the live terminal manager; historical tool output is not a process list. */
export function EnvironmentProcessesSection({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const [state, setState] = useState<{ sessionId: string; items: TerminalProcessSummary[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const items = await window.electron.terminal.listProcesses(sessionId);
        if (!cancelled) setState({ sessionId, items, error: false });
      } catch {
        if (!cancelled) setState({ sessionId, items: [], error: true });
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionId, active]);
  const current = state?.sessionId === sessionId ? state : null;
  return <section className="environment-summary-section" aria-label="Background processes">
    <div className="px-2 pb-1 text-xs text-[var(--text-muted)]" title="Running processes in this conversation’s integrated terminals">Background processes</div>
    {current?.items.map(item => <div key={item.terminalId} className="environment-summary-row" title={`Terminal ${item.terminalId} · PID ${item.pid}`}>
      <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{item.agentKind === 'shell' ? 'Terminal process' : item.agentKind}</span>
      <span className="text-xs text-[var(--text-muted)]">{item.pid}</span>
    </div>)}
    {!current?.items.length ? <p role="status" className="px-2 py-1 text-xs text-[var(--text-muted)]">
      {current?.error ? 'Unable to read terminal processes.' : sessionId && !current ? 'Checking processes…' : 'No running terminal processes.'}
    </p> : null}
  </section>;
}
