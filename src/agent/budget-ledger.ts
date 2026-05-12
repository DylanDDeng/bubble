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

export class BudgetLedger {
  private spent = 0;
  private readonly controller = new AbortController();

  constructor(private readonly limit?: number) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  recordUsage(usage: TokenUsage, source: BudgetUsageSource): void {
    const delta = usage.promptTokens + usage.completionTokens;
    this.spent += delta;
    if (this.limit !== undefined && this.spent >= this.limit && !this.controller.signal.aborted) {
      this.controller.abort(budgetAbortError("Budget exhausted"));
    }
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
