import { describe, expect, it } from "vitest";
import { goalCompleteNotice } from "../goal/format.js";
import { GoalStore } from "../goal/store.js";

function goal(setup: (s: GoalStore) => void): ReturnType<GoalStore["snapshot"]> {
  const store = new GoalStore();
  setup(store);
  return store.snapshot();
}

describe("goalCompleteNotice", () => {
  it("reports tokens used and turns when no budget is set", () => {
    const g = goal((s) => {
      s.set("x");
      s.addTokens(45_200);
      s.incrementTurn();
      s.incrementTurn();
      s.incrementTurn();
    })!;
    expect(goalCompleteNotice(g)).toBe("Goal complete — 45.2K tok used over 3 turns.");
  });

  it("shows used/budget when a budget is set", () => {
    const g = goal((s) => {
      s.set("x", { tokenBudget: 200_000 });
      s.addTokens(45_200);
      s.incrementTurn();
    })!;
    expect(goalCompleteNotice(g)).toBe("Goal complete — 45.2K/200K tok used over 1 turn.");
  });
});
