import { useEffect, useState } from 'react';
import type { BubbleSubagentState } from '../../shared/types';
import type { ChildOperation } from '../utils/bubble-subagent-view';

/** No invented progress/ETA: show the last actual runtime activity and its age. */
export function SubagentActivity({ runtime, operations = [], active, details = false }: {
  runtime?: BubbleSubagentState; operations?: ChildOperation[]; active: boolean; details?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  if (!runtime) return null;
  const age = Math.max(0, Math.floor((now - runtime.updatedAt) / 1000));
  const waiting = active && operations.some(operation => operation.pending && operation.label.startsWith('Main agent'));
  const failed = operations.filter(operation => operation.failed);
  return <div className="min-w-0 space-y-1 text-[11px] text-[var(--text-muted)]">
    {active && <div>{runtime.status === 'queued' ? 'Queued' : runtime.activity} · {age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} since last update</div>}
    {waiting && <div>Main agent is waiting for this subagent</div>}
    {runtime.pendingInputCount > 0 && active && <div>{runtime.pendingInputCount} supplementary message(s) queued for the next safe boundary</div>}
    {runtime.inputDelivery === 'applied' && <div>Supplementary message delivered</div>}
    {(runtime.inputDelivery === 'rejected' || (runtime.pendingInputCount > 0 && !active)) && <div className="text-[var(--warning)]">Supplementary message was not delivered</div>}
    {failed.map(operation => <div key={operation.id} className="text-[var(--warning)]">Earlier attempt: {operation.label}{active ? '; subagent continues running' : ''}</div>)}
    {details && <details className="pt-2"><summary className="cursor-pointer">Task and coordination details</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{runtime.task}</p>
      {operations.map(operation => <details className="mt-2" key={operation.id}><summary className="cursor-pointer">{operation.label}</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all">{operation.detail}</pre></details>)}
    </details>}
  </div>;
}
