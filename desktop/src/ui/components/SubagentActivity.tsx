import type { BubbleSubagentState } from '../../shared/types';
import type { ChildOperation } from '../utils/bubble-subagent-view';

/** User-relevant supplementary-message status; scheduler history stays in raw records. */
export function SubagentActivity({ runtime, operations = [], active }: {
  runtime?: BubbleSubagentState; operations?: ChildOperation[]; active: boolean;
}) {
  if (!runtime) return null;
  const failed = operations.filter(operation => operation.failed && operation.toolName !== 'wait_agent');
  return <div className="min-w-0 space-y-1 text-[11px] text-[var(--text-muted)]">
    {runtime.pendingInputCount > 0 && active && <div>{runtime.pendingInputCount} supplementary message(s) queued for the next safe boundary</div>}
    {runtime.inputDelivery === 'applied' && <div>Supplementary message delivered</div>}
    {(runtime.inputDelivery === 'rejected' || (runtime.pendingInputCount > 0 && !active)) && <div className="text-[var(--warning)]">Supplementary message was not delivered</div>}
    {failed.map(operation => <div key={operation.id} className="text-[var(--warning)]">Earlier attempt: {operation.label}{active ? '; subagent continues running' : ''}</div>)}
  </div>;
}
