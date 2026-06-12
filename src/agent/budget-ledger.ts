import type { TokenUsage } from "../types.js";
import type { SubagentTokenCap } from "./subagent-control.js";

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
 * accounting so the runtime can enforce per-child caps (design doc §6).
 * The shared pool limit is optional — both production hosts construct the
 * ledger without one — so per-child caps must never be derived solely from
 * "pool remaining"; see computeChildTokenCap.
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

/** Default absolute per-child soft cap; applies even on limit-free hosts. */
export const DEFAULT_CHILD_TOKEN_CAP = 200_000;
/** Share of a limited pool reserved for the parent's own turns. */
export const PARENT_POOL_RESERVE_RATIO = 0.2;
/** Hard cap sits at least this many tokens above the soft cap (≈ 2 turns). */
export const CHILD_HARD_CAP_FLOOR = 20_000;

/**
 * Per-child token cap, fixed at dispatch (design doc §6). The soft cap is an
 * absolute number (config default 200k) so it is effective on limit-free
 * hosts; when the pool *is* limited, the fair share of what remains after the
 * parent's reserve further bounds it. The cap never shrinks mid-run because
 * siblings spawned later.
 */
export function computeChildTokenCap(options: {
  ledger?: BudgetLedger;
  subAgentId: string;
  activeChildren: number;
  configCap?: number;
  profileMaxTokens?: number;
}): SubagentTokenCap {
  let soft = options.configCap ?? DEFAULT_CHILD_TOKEN_CAP;
  if (options.profileMaxTokens !== undefined && options.profileMaxTokens > 0) {
    soft = Math.min(soft, options.profileMaxTokens);
  }
  const limit = options.ledger?.poolLimit;
  if (options.ledger && limit !== undefined) {
    const reserve = Math.floor(limit * PARENT_POOL_RESERVE_RATIO);
    const available = Math.max(0, (options.ledger.remaining() ?? 0) - reserve);
    const share = Math.floor(available / (options.activeChildren + 1));
    soft = Math.max(1, Math.min(soft, share));
  }
  return {
    soft,
    hard: soft + CHILD_HARD_CAP_FLOOR,
    baseline: options.ledger?.spentBy(options.subAgentId) ?? 0,
  };
}

/**
 * Hard cap recomputed at each turn-boundary check: at least ~2 of this
 * child's average turns above the soft cap, never below the absolute floor
 * (design doc §6 — replaces the fixed 25% ratio that could be smaller than a
 * single turn).
 */
export function childHardCap(soft: number, avgTurnTokens: number): number {
  return soft + Math.max(CHILD_HARD_CAP_FLOOR, Math.ceil(avgTurnTokens * 2));
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
