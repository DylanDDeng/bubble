import type { TokenUsage } from "../types.js";

export interface BudgetUsageSource {
  runId: string;
  subAgentId?: string;
}

export interface BudgetSnapshot {
  spent: number;
  limit?: number;
  exhausted: boolean;
}

const PARENT_SOURCE_KEY = "__parent__";

/**
 * Shared token ledger for a parent and all of its children, with per-source
 * accounting. Pure bookkeeping: children are never stopped for token usage —
 * their only bound is the model context window, absorbed by compaction
 * (design doc §6). The optional pool limit exists for hosts that explicitly
 * declare one; both production hosts construct the ledger without it.
 */
export class BudgetLedger {
  private spent = 0;
  private readonly spentBySource = new Map<string, number>();
  private readonly controller = new AbortController();

  constructor(private readonly limit?: number) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  recordUsage(usage: TokenUsage, source: BudgetUsageSource): void {
    const delta = usage.promptTokens + usage.completionTokens;
    this.spent += delta;
    const key = source.subAgentId ?? PARENT_SOURCE_KEY;
    this.spentBySource.set(key, (this.spentBySource.get(key) ?? 0) + delta);
    if (this.limit !== undefined && this.spent >= this.limit && !this.controller.signal.aborted) {
      this.controller.abort(budgetAbortError("Budget exhausted"));
    }
  }

  /** Tokens attributed to one child (or the parent when subAgentId is omitted). */
  spentBy(subAgentId?: string): number {
    return this.spentBySource.get(subAgentId ?? PARENT_SOURCE_KEY) ?? 0;
  }

  /** Pool tokens remaining, or undefined when the pool has no limit. */
  remaining(): number | undefined {
    if (this.limit === undefined) return undefined;
    return Math.max(0, this.limit - this.spent);
  }

  get poolLimit(): number | undefined {
    return this.limit;
  }

  snapshot(): BudgetSnapshot {
    return {
      spent: this.spent,
      limit: this.limit,
      exhausted: this.limit !== undefined && this.spent >= this.limit,
    };
  }
}

function budgetAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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
