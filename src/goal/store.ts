/**
 * GoalStore — the in-memory source of truth for the autonomous `/goal` feature.
 *
 * A single GoalStore instance is shared between the goal tools (so the model's
 * `update_goal` calls mutate the same state the TUI reads) and the TUI's
 * auto-continuation engine / status-line indicator. State is a plain
 * serializable object so it can be persisted to and reloaded from the session
 * metadata.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "budget_limited";

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Optional positive token budget; auto-continuation stops once reached. */
  tokenBudget?: number;
  tokensUsed: number;
  /** Goal turns where the provider did not report token usage. */
  untrackedTokenTurns?: number;
  /** Number of completed goal turns (including the initial turn). */
  turnsSpent: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalStoreOptions {
  now?: () => number;
  genId?: () => string;
}

export type GoalChangeListener = (goal: GoalState | null) => void;

export class GoalStore {
  private goal: GoalState | null = null;
  private readonly listeners = new Set<GoalChangeListener>();
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(options: GoalStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.genId =
      options.genId ??
      (() => `goal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  snapshot(): GoalState | null {
    return this.goal ? { ...this.goal } : null;
  }

  /** Alias for snapshot(); reads the current goal without mutating. */
  get(): GoalState | null {
    return this.snapshot();
  }

  isActive(): boolean {
    return this.goal?.status === "active";
  }

  onChange(listener: GoalChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private touch(): void {
    if (this.goal) this.goal.updatedAt = this.now();
  }

  set(objective: string, options: { tokenBudget?: number } = {}): GoalState {
    const ts = this.now();
    const tokenBudget =
      options.tokenBudget !== undefined && options.tokenBudget > 0
        ? Math.round(options.tokenBudget)
        : undefined;
    this.goal = {
      id: this.genId(),
      objective: objective.trim(),
      status: "active",
      tokenBudget,
      tokensUsed: 0,
      untrackedTokenTurns: 0,
      turnsSpent: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.emit();
    return this.snapshot()!;
  }

  clear(): void {
    if (!this.goal) return;
    this.goal = null;
    this.emit();
  }

  edit(objective: string): GoalState | null {
    if (!this.goal) return null;
    this.goal.objective = objective.trim();
    this.touch();
    this.emit();
    return this.snapshot();
  }

  /** Update the token budget without resetting accumulated progress. */
  setBudget(tokenBudget: number | undefined): GoalState | null {
    if (!this.goal) return null;
    this.goal.tokenBudget =
      tokenBudget !== undefined && tokenBudget > 0 ? Math.round(tokenBudget) : undefined;
    this.touch();
    this.emit();
    return this.snapshot();
  }

  pause(): GoalState | null {
    if (!this.goal) return null;
    if (this.goal.status === "active" || this.goal.status === "budget_limited") {
      this.goal.status = "paused";
      this.touch();
      this.emit();
    }
    return this.snapshot();
  }

  resume(): GoalState | null {
    if (!this.goal) return null;
    if (
      this.goal.status === "paused" ||
      this.goal.status === "blocked" ||
      this.goal.status === "budget_limited"
    ) {
      this.goal.status = "active";
      this.touch();
      this.emit();
    }
    return this.snapshot();
  }

  markComplete(): GoalState | null {
    return this.setStatus("complete");
  }

  markBlocked(): GoalState | null {
    return this.setStatus("blocked");
  }

  markBudgetLimited(): GoalState | null {
    return this.setStatus("budget_limited");
  }

  private setStatus(status: GoalStatus): GoalState | null {
    if (!this.goal) return null;
    this.goal.status = status;
    this.touch();
    this.emit();
    return this.snapshot();
  }

  addTokens(n: number): void {
    if (!this.goal || !Number.isFinite(n) || n <= 0) return;
    this.goal.tokensUsed += Math.round(n);
    this.touch();
    this.emit();
  }

  markTokenUsageUnavailable(): void {
    if (!this.goal) return;
    this.goal.untrackedTokenTurns = (this.goal.untrackedTokenTurns ?? 0) + 1;
    this.touch();
    this.emit();
  }

  incrementTurn(): void {
    if (!this.goal) return;
    this.goal.turnsSpent += 1;
    this.touch();
    this.emit();
  }

  /** True when a token budget is set and usage has reached or exceeded it. */
  isBudgetExceeded(): boolean {
    return (
      this.goal?.tokenBudget !== undefined &&
      this.goal.tokensUsed >= this.goal.tokenBudget
    );
  }

  remainingTokens(): number | undefined {
    if (this.goal?.tokenBudget === undefined) return undefined;
    return Math.max(0, this.goal.tokenBudget - this.goal.tokensUsed);
  }

  /** Restore from persisted state (e.g. on session resume). */
  loadFrom(state: GoalState | null | undefined): void {
    if (!state || !state.objective?.trim()) {
      this.goal = null;
    } else {
      this.goal = {
        ...state,
        untrackedTokenTurns:
          state.untrackedTokenTurns !== undefined && state.untrackedTokenTurns > 0
            ? Math.round(state.untrackedTokenTurns)
            : 0,
      };
    }
    this.emit();
  }
}
