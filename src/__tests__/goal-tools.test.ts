import { describe, expect, it } from "vitest";
import { createGoalTools } from "../goal/tools.js";
import { GoalStore } from "../goal/store.js";
import { buildEnvironmentPrompt } from "../prompt/environment.js";
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

  it("stays out of the ambient Available-tools list — no completion-marker bait", () => {
    // A goal-completion tool advertised in every session's prompt gets called
    // spuriously at turn end even by strong models (observed: gpt-5.6-sol,
    // high effort, no goal set). No promptSnippet → the environment prompt's
    // visible-tools filter drops it; goal turns inject usage guidance instead.
    const { updateGoal } = tools(new GoalStore());
    expect(updateGoal.promptSnippet).toBeUndefined();

    const prompt = buildEnvironmentPrompt({
      tools: ["read", "update_goal"],
      toolSnippets: { read: "Read a file." },
    });
    expect(prompt).toContain("- read:");
    expect(prompt).not.toContain("update_goal");
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
