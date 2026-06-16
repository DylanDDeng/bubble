/**
 * Model-facing goal tools: get_goal and update_goal.
 *
 * Both read/write the shared GoalStore so the model's completion/blocked signal
 * stops the TUI's auto-continuation loop. The user sets goals via `/goal`, so
 * there is intentionally no model-facing create_goal tool.
 */

import type { ToolRegistryEntry } from "../types.js";
import type { GoalStore } from "./store.js";
import { goalSummaryText } from "./format.js";

const UPDATE_GOAL_DESCRIPTION = `Update the active thread goal's status. Use this tool only to mark the goal achieved or genuinely blocked; it returns an error if there is no active goal.
Set status to "complete" only when the objective has actually been achieved and no required work remains — never merely because the budget is nearly exhausted or you are stopping.
Set status to "blocked" only when the same blocking condition has repeated for at least three consecutive goal turns (counting the original turn and automatic continuations) and you cannot make meaningful progress without user input or an external-state change. Do not use "blocked" because work is hard, slow, uncertain, or incomplete.
You cannot pause, resume, or set a budget through this tool; those are controlled by the user.`;

export function createGoalTools(store: GoalStore): ToolRegistryEntry[] {
  const getGoal: ToolRegistryEntry = {
    name: "get_goal",
    description:
      "Get the current thread goal: objective, status, turns and tokens used, and remaining token budget. Returns an error if there is no goal.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    readOnly: true,
    effect: "read",
    promptSnippet: "Inspect the active goal's status and remaining token budget.",
    async execute(): Promise<{ content: string; isError?: boolean }> {
      const goal = store.snapshot();
      if (!goal) return { content: "No active goal.", isError: true };
      return { content: goalSummaryText(goal) };
    },
  };

  const updateGoal: ToolRegistryEntry = {
    name: "update_goal",
    description: UPDATE_GOAL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["complete", "blocked"],
          description:
            'Set to "complete" only when the objective is achieved and verified; set to "blocked" only after the strict blocked audit is satisfied.',
        },
      },
      required: ["status"],
      additionalProperties: false,
    },
    effect: "unknown",
    promptSnippet: "Mark the goal complete (objective achieved) or blocked (true impasse).",
    async execute(args): Promise<{ content: string; isError?: boolean }> {
      const goal = store.snapshot();
      if (!goal) return { content: "No active goal to update.", isError: true };
      const status = String(args.status ?? "").toLowerCase();
      if (status === "complete") {
        store.markComplete();
        const budgetNote =
          goal.tokenBudget !== undefined
            ? ` Final token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`
            : ` Tokens used: ${goal.tokensUsed}.`;
        return { content: `Goal marked complete.${budgetNote}` };
      }
      if (status === "blocked") {
        store.markBlocked();
        return {
          content:
            "Goal marked blocked. Automatic continuation has stopped; the user can resume it with /goal resume.",
        };
      }
      return {
        content: `Invalid status "${args.status}". Use "complete" or "blocked".`,
        isError: true,
      };
    },
  };

  return [getGoal, updateGoal];
}
