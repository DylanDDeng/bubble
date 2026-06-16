import { describe, expect, it } from "vitest";
import { createGoalTools } from "../goal/tools.js";
import { GoalStore } from "../goal/store.js";
import type { ToolContext } from "../types.js";

const ctx = { cwd: "/tmp" } as ToolContext;

function tools(store: GoalStore) {
  const list = createGoalTools(store);
  return {
    getGoal: list.find((t) => t.name === "get_goal")!,
    updateGoal: list.find((t) => t.name === "update_goal")!,
  };
}

describe("goal tools", () => {
  it("registers get_goal (read-only) and update_goal", () => {
    const { getGoal, updateGoal } = tools(new GoalStore());
    expect(getGoal.readOnly).toBe(true);
    expect(updateGoal.parameters.properties.status.enum).toEqual(["complete", "blocked"]);
  });

  it("get_goal errors with no goal and summarizes when present", async () => {
    const store = new GoalStore();
    const { getGoal } = tools(store);
    expect((await getGoal.execute({}, ctx)).isError).toBe(true);
    store.set("Refactor auth", { tokenBudget: 1000 });
    const res = await getGoal.execute({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/Refactor auth/);
    expect(res.content).toMatch(/active/);
  });

  it("update_goal errors without a goal", async () => {
    const { updateGoal } = tools(new GoalStore());
    expect((await updateGoal.execute({ status: "complete" }, ctx)).isError).toBe(true);
  });

  it("update_goal marks complete and reports usage", async () => {
    const store = new GoalStore();
    store.set("x", { tokenBudget: 1000 });
    store.addTokens(640);
    const { updateGoal } = tools(store);
    const res = await updateGoal.execute({ status: "complete" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(store.snapshot()!.status).toBe("complete");
    expect(res.content).toMatch(/640\/1000/);
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
