import { describe, expect, it } from "vitest";
import { shouldContinueGoal, stopReasonNotice, GOAL_MAX_AUTO_TURNS } from "../goal/engine.js";
import type { GoalState } from "../goal/store.js";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "g",
    objective: "x",
    status: "active",
    tokensUsed: 0,
    turnsSpent: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("shouldContinueGoal", () => {
  it("continues an active goal under budget and cap", () => {
    expect(shouldContinueGoal({ goal: goal(), autoTurns: 0 })).toEqual({ continue: true });
  });

  it("stops when there is no goal", () => {
    expect(shouldContinueGoal({ goal: null })).toEqual({ continue: false, reason: "no_goal" });
  });

  it("stops on cancellation and queued user input before checking status", () => {
    expect(shouldContinueGoal({ goal: goal(), cancelled: true })).toEqual({ continue: false, reason: "cancelled" });
    expect(shouldContinueGoal({ goal: goal(), queuedInputs: 1 })).toEqual({ continue: false, reason: "user_input" });
  });

  it("stops on terminal/paused statuses", () => {
    expect(shouldContinueGoal({ goal: goal({ status: "complete" }) }).reason).toBe("complete");
    expect(shouldContinueGoal({ goal: goal({ status: "blocked" }) }).reason).toBe("blocked");
    expect(shouldContinueGoal({ goal: goal({ status: "paused" }) }).reason).toBe("paused");
    expect(shouldContinueGoal({ goal: goal({ status: "budget_limited" }) }).reason).toBe("budget");
  });

  it("stops when the token budget is reached", () => {
    expect(shouldContinueGoal({ goal: goal({ tokenBudget: 100, tokensUsed: 100 }) })).toEqual({
      continue: false,
      reason: "budget",
    });
    expect(shouldContinueGoal({ goal: goal({ tokenBudget: 100, tokensUsed: 99 }) })).toEqual({ continue: true });
  });

  it("stops when the auto-continuation cap is reached", () => {
    expect(shouldContinueGoal({ goal: goal(), autoTurns: GOAL_MAX_AUTO_TURNS })).toEqual({
      continue: false,
      reason: "cap",
    });
    expect(shouldContinueGoal({ goal: goal(), autoTurns: 2, cap: 2 }).reason).toBe("cap");
  });
});

describe("stopReasonNotice", () => {
  it("returns a message for actionable stop reasons and empty for none", () => {
    expect(stopReasonNotice("complete")).toMatch(/complete/i);
    expect(stopReasonNotice("budget")).toMatch(/budget/i);
    expect(stopReasonNotice("cap")).toMatch(/limit/i);
    expect(stopReasonNotice("no_goal")).toBe("");
    expect(stopReasonNotice(undefined)).toBe("");
  });
});
