/**
 * Autonomous Goal runtime for the framework-neutral TUI controller.
 *
 * The GoalStore remains the single source of truth shared with the model-facing
 * update_goal tool. This class owns the host lifecycle around it: slash command
 * handling, session persistence, hidden continuation turns, usage accounting,
 * and stop/resume semantics. Renderers only read the resulting snapshot.
 */
import type { SessionManager } from "../../session.js";
import { formatInternalContextBlock } from "../../agent/internal-reminder-sanitizer.js";
import { parseGoalCommand } from "../../goal/command.js";
import { shouldContinueGoal, stopReasonNotice } from "../../goal/engine.js";
import { goalCompleteNotice, goalIndicatorLine, goalSummaryText } from "../../goal/format.js";
import { continuationPrompt, initialPrompt } from "../../goal/prompts.js";
import type { GoalState, GoalStatus, GoalStore } from "../../goal/store.js";

export interface GoalRunSummary {
  goalRun: boolean;
  goalStatusAtStart?: GoalStatus;
  cancelled: boolean;
  errored: boolean;
  usageTokens: number;
  usageReported: boolean;
}

export interface GoalRuntimeControllerDeps {
  store: GoalStore;
  getSessionManager(): SessionManager;
  isRunActive(): boolean;
  queuedInputs(): number;
  isDisposed(): boolean;
  startRun(input: string, cwd: string): void;
  appendMessage(role: "user" | "assistant" | "error", content: string): void;
  onStateChanged(): void;
  schedule?(callback: () => void): void;
}

export class GoalRuntimeController {
  private persistSuspended = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: GoalRuntimeControllerDeps) {
    this.unsubscribe = deps.store.onChange((goal) => {
      if (!this.persistSuspended) this.persistGoal(goal);
      this.deps.onStateChanged();
    });
    this.loadCurrentSession();
  }

  dispose(): void {
    this.unsubscribe();
  }

  snapshot(): GoalState | null {
    return this.deps.store.snapshot();
  }

  indicatorLine(): string | undefined {
    const goal = this.snapshot();
    return goal ? goalIndicatorLine(goal) : undefined;
  }

  /** Restore the newly bound session without resurrecting an autonomous run. */
  loadCurrentSession(): void {
    let persisted: GoalState | undefined;
    try {
      persisted = this.deps.getSessionManager().getMetadata().goal;
    } catch {
      persisted = undefined;
    }

    this.persistSuspended = true;
    try {
      this.deps.store.loadFrom(
        persisted?.status === "active" ? { ...persisted, status: "paused" } : persisted,
      );
    } finally {
      this.persistSuspended = false;
    }
  }

  handleCommand(input: string, cwd: string): void {
    if (this.externalRuntimeBound()) {
      this.deps.appendMessage(
        "error",
        "/goal is available in native Bubble sessions, not in the current external runtime session.",
      );
      return;
    }

    const command = parseGoalCommand(input);
    if (command.error) {
      this.deps.appendMessage("error", command.error);
      return;
    }

    const existing = this.snapshot();
    switch (command.kind) {
      case "show":
        this.notice(existing ? goalSummaryText(existing) : "No active goal. Set one with /goal <objective>");
        return;
      case "clear":
        if (!existing) {
          this.notice("No active goal to clear");
          return;
        }
        this.deps.store.clear();
        this.notice("Goal cleared");
        return;
      case "pause":
        if (!existing) {
          this.notice("No active goal to pause");
          return;
        }
        this.deps.store.pause();
        this.notice("Goal paused — /goal resume to continue");
        return;
      case "resume": {
        if (!existing) {
          this.notice("No goal to resume. Set one with /goal <objective>");
          return;
        }
        const resumed = this.deps.store.resume();
        if (resumed?.status !== "active") {
          this.notice("Goal cannot be resumed (already complete)");
          return;
        }
        this.notice("Goal resumed");
        this.scheduleGoalTurn(resumed, cwd, false);
        return;
      }
      case "edit":
        if (!existing) {
          this.notice("No active goal to edit. Set one with /goal <objective>");
          return;
        }
        this.deps.store.edit(command.objective!);
        if (command.tokenBudget !== undefined) this.deps.store.setBudget(command.tokenBudget);
        this.notice(`Goal updated: ${truncate(this.snapshot()!.objective, 60)}`);
        return;
      case "set": {
        const goal = this.deps.store.set(command.objective!, { tokenBudget: command.tokenBudget });
        this.deps.appendMessage("user", input.trim());
        const budgetNote = goal.tokenBudget !== undefined ? ` (budget ${goal.tokenBudget} tok)` : "";
        this.notice(`Goal set${budgetNote} — working autonomously. /goal pause to stop.`);
        this.scheduleGoalTurn(goal, cwd, true);
      }
    }
  }

  /** Called once after every controller run, before queued next-turn input drains. */
  afterRun(summary: GoalRunSummary, cwd: string): void {
    if (this.deps.isDisposed()) return;
    const before = this.snapshot();
    if (!before) return;

    const belongsToGoal = summary.goalRun
      || summary.goalStatusAtStart === "active"
      || before.status === "active";
    if (!belongsToGoal) return;

    if (summary.cancelled || summary.errored) {
      if (before.status === "active") {
        this.deps.store.pause();
        this.notice(stopReasonNotice(summary.errored ? "error" : "cancelled"));
      }
      return;
    }

    if (summary.goalRun) {
      if (summary.usageReported) {
        if (summary.usageTokens > 0) this.deps.store.addTokens(summary.usageTokens);
      } else {
        this.deps.store.markTokenUsageUnavailable();
      }
      this.deps.store.incrementTurn();
    }

    const goal = this.snapshot();
    if (!goal) return;
    const decision = shouldContinueGoal({
      goal,
      queuedInputs: this.deps.queuedInputs(),
    });

    if (decision.continue) {
      this.scheduleGoalTurn(goal, cwd, false);
      return;
    }

    if (decision.reason === "budget" && goal.status === "active") {
      this.deps.store.markBudgetLimited();
    }
    if (decision.reason === "complete") {
      this.notice(goalCompleteNotice(goal));
      return;
    }
    // An explicit /goal pause already emitted its user-facing notice. Other
    // stop causes (blocked, budget, queued input) originate at this boundary.
    if (decision.reason === "paused") return;
    const note = stopReasonNotice(decision.reason);
    if (note) this.notice(note);
  }

  private scheduleGoalTurn(goal: GoalState, cwd: string, initial: boolean): void {
    if (this.deps.isRunActive() || this.deps.isDisposed()) return;
    const schedule = this.deps.schedule ?? queueMicrotask;
    schedule(() => {
      if (this.deps.isDisposed() || this.deps.isRunActive()) return;
      const current = this.snapshot();
      if (!current || current.id !== goal.id || current.status !== "active") return;
      const prompt = initial ? initialPrompt(current) : continuationPrompt(current);
      this.deps.startRun(formatInternalContextBlock("goal", prompt), cwd);
    });
  }

  private persistGoal(goal: GoalState | null): void {
    try {
      const manager = this.deps.getSessionManager();
      manager.setMetadata({ ...manager.getMetadata(), goal: goal ?? undefined });
    } catch {
      // Persistence is best-effort; a filesystem failure must not break a run.
    }
  }

  private externalRuntimeBound(): boolean {
    try {
      return this.deps.getSessionManager().getMetadata().externalRuntime !== undefined;
    } catch {
      return false;
    }
  }

  private notice(content: string): void {
    this.deps.appendMessage("assistant", content);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
