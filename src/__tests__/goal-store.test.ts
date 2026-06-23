import { describe, expect, it } from "vitest";
import { GoalStore } from "../goal/store.js";

function makeStore() {
  let t = 1000;
  let n = 0;
  return new GoalStore({ now: () => (t += 1), genId: () => `goal_${n++}` });
}

describe("GoalStore", () => {
  it("sets an active goal and snapshots immutably", () => {
    const store = makeStore();
    const goal = store.set("Refactor auth", { tokenBudget: 50000 });
    expect(goal.objective).toBe("Refactor auth");
    expect(goal.status).toBe("active");
    expect(goal.tokenBudget).toBe(50000);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.turnsSpent).toBe(0);

    const snap = store.snapshot()!;
    snap.tokensUsed = 999;
    expect(store.snapshot()!.tokensUsed).toBe(0); // snapshot is a copy
  });

  it("ignores non-positive token budgets", () => {
    const store = makeStore();
    expect(store.set("x", { tokenBudget: 0 }).tokenBudget).toBeUndefined();
    expect(store.set("x", { tokenBudget: -5 }).tokenBudget).toBeUndefined();
  });

  it("accumulates tokens and turns; detects budget exhaustion", () => {
    const store = makeStore();
    store.set("x", { tokenBudget: 100 });
    store.addTokens(40);
    store.incrementTurn();
    expect(store.snapshot()!.tokensUsed).toBe(40);
    expect(store.snapshot()!.turnsSpent).toBe(1);
    expect(store.isBudgetExceeded()).toBe(false);
    expect(store.remainingTokens()).toBe(60);
    store.addTokens(70);
    expect(store.isBudgetExceeded()).toBe(true);
    expect(store.remainingTokens()).toBe(0);
  });

  it("ignores invalid token deltas", () => {
    const store = makeStore();
    store.set("x");
    store.addTokens(-1);
    store.addTokens(Number.NaN);
    store.addTokens(0);
    expect(store.snapshot()!.tokensUsed).toBe(0);
  });

  it("tracks goal turns whose provider usage is unavailable", () => {
    const store = makeStore();
    store.set("x");
    store.markTokenUsageUnavailable();
    store.markTokenUsageUnavailable();
    expect(store.snapshot()!.untrackedTokenTurns).toBe(2);
  });

  it("transitions pause/resume/complete/blocked/budget", () => {
    const store = makeStore();
    store.set("x");
    store.pause();
    expect(store.snapshot()!.status).toBe("paused");
    store.resume();
    expect(store.snapshot()!.status).toBe("active");
    store.markBudgetLimited();
    expect(store.snapshot()!.status).toBe("budget_limited");
    store.resume(); // budget_limited is resumable
    expect(store.snapshot()!.status).toBe("active");
    store.markBlocked();
    expect(store.snapshot()!.status).toBe("blocked");
    store.resume(); // blocked is resumable
    expect(store.snapshot()!.status).toBe("active");
    store.markComplete();
    expect(store.snapshot()!.status).toBe("complete");
    store.resume(); // complete is terminal — not resumable
    expect(store.snapshot()!.status).toBe("complete");
  });

  it("setBudget updates budget without resetting progress", () => {
    const store = makeStore();
    store.set("x", { tokenBudget: 100 });
    store.addTokens(30);
    store.incrementTurn();
    store.setBudget(200);
    expect(store.snapshot()!.tokenBudget).toBe(200);
    expect(store.snapshot()!.tokensUsed).toBe(30);
    expect(store.snapshot()!.turnsSpent).toBe(1);
    store.setBudget(undefined);
    expect(store.snapshot()!.tokenBudget).toBeUndefined();
  });

  it("clears and notifies listeners; loadFrom restores state", () => {
    const store = makeStore();
    const seen: (string | null)[] = [];
    store.onChange((g) => seen.push(g?.status ?? null));
    store.set("x");
    store.clear();
    expect(store.snapshot()).toBeNull();
    expect(seen).toEqual(["active", null]);

    store.loadFrom({
      id: "g1",
      objective: "resumed",
      status: "paused",
      tokensUsed: 12,
      turnsSpent: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(store.snapshot()!.objective).toBe("resumed");
    expect(store.snapshot()!.turnsSpent).toBe(3);

    store.loadFrom(null);
    expect(store.snapshot()).toBeNull();
    store.loadFrom({ id: "g2", objective: "  ", status: "active", tokensUsed: 0, turnsSpent: 0, createdAt: 0, updatedAt: 0 });
    expect(store.snapshot()).toBeNull(); // blank objective is treated as no goal
  });
});
