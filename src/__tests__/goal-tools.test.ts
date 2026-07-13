import { describe, expect, it } from "vitest";
import { createGoalTools } from "../goal/tools.js";
import { GoalStore } from "../goal/store.js";
import type { ToolContext } from "../types.js";

const ctx = { cwd: "/tmp" } as ToolContext;

function tools(store: GoalStore) {
  const list = createGoalTools(store);
  return {
    list,
    updateGoal: list.find((t) => t.name === "update_goal")!,
  };
}

describe("goal tools", () => {
  it("registers only update_goal — goal state is prompt-injected, not tool-read", () => {
    const { list, updateGoal } = tools(new GoalStore());
    expect(list.map((t) => t.name)).toEqual(["update_goal"]);
    expect(updateGoal.parameters.properties.status.enum).toEqual(["complete", "blocked"]);
  });

  it("update_goal errors without a goal", async () => {
    const { updateGoal } = tools(new GoalStore());
    expect((await updateGoal.execute({ status: "complete" }, ctx)).isError).toBe(true);
  });

  it("update_goal marks complete without reporting a (necessarily stale) token figure", async () => {
    const store = new GoalStore();
    store.set("x", { tokenBudget: 1000 });
    store.addTokens(640);
    const { updateGoal } = tools(store);
    const res = await updateGoal.execute({ status: "complete" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(store.snapshot()!.status).toBe("complete");
    expect(res.content).toBe("Goal marked complete.");
    // The current turn's tokens aren't accounted until turn_end (after tools
    // run), so the tool must not claim a token total — the harness reports it.
    expect(res.content).not.toMatch(/\d/);
  });

  it("update_goal marks blocked", async () => {
    const store = new GoalStore();
    store.set("x");
    const { updateGoal } = tools(store);
    await updateGoal.execute({ status: "blocked" }, ctx);
    expect(store.snapshot()!.status).toBe("blocked");
  });

  it("update_goal rejects an invalid status", async () => {
    const store = new GoalStore();
    store.set("x");
    const { updateGoal } = tools(store);
    const res = await updateGoal.execute({ status: "paused" }, ctx);
    expect(res.isError).toBe(true);
    expect(store.snapshot()!.status).toBe("active");
  });
});
