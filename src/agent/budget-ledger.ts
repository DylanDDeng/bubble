import type { TokenUsage } from "../types.js";

export interface BudgetUsageSource {
  runId: string;
  subAgentId?: string;
}

const PARENT_SOURCE_KEY = "__parent__";

/**
 * Shared token ledger for a parent and all of its children, with per-source
 * accounting. Pure bookkeeping: nothing is ever stopped for token usage —
 * a child's only resource bound is the model context window, absorbed by
 * compaction (design doc §6, revised 2026-07-06).
 */
export class BudgetLedger {
  private spent = 0;
  private readonly spentBySource = new Map<string, number>();

  recordUsage(usage: TokenUsage, source: BudgetUsageSource): void {
    const delta = usage.promptTokens + usage.completionTokens;
    this.spent += delta;
    const key = source.subAgentId ?? PARENT_SOURCE_KEY;
    this.spentBySource.set(key, (this.spentBySource.get(key) ?? 0) + delta);
  }

  /** Tokens attributed to one child (or the parent when subAgentId is omitted). */
  spentBy(subAgentId?: string): number {
    return this.spentBySource.get(subAgentId ?? PARENT_SOURCE_KEY) ?? 0;
  }

  totalSpent(): number {
    return this.spent;
  }
}

export function composeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => !!signal);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason);
  };

  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}
