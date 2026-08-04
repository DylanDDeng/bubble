/**
 * Model-facing goal tool: update_goal.
 *
 * It writes the shared GoalStore so the model's completion/blocked signal
 * stops the TUI's auto-continuation loop. The user sets goals via `/goal`, so
 * there is intentionally no model-facing create_goal tool — and no read tool:
 * the goal engine already injects the objective plus budget state into every
 * goal turn's prompt, so a get_goal call could only return what the model was
 * just told.
 */

import type { ToolRegistryEntry } from "../types.js";
import type { GoalStore } from "./store.js";

const UPDATE_GOAL_DESCRIPTION = `Errors unless the user has set an active goal via /goal — do NOT call this to wrap up an ordinary turn; most sessions have no goal.
Update the active thread goal's status. Set status to "complete" only when the objective has actually been achieved and no required work remains — never merely because the budget is nearly exhausted or you are stopping.
Set status to "blocked" only when the same blocking condition has repeated for at least three consecutive goal turns (counting the original turn and automatic continuations) and you cannot make meaningful progress without user input or an external-state change. Do not use "blocked" because work is hard, slow, uncertain, or incomplete.
You cannot pause, resume, or set a budget through this tool; those are controlled by the user.`;

export function createGoalTools(store: GoalStore): ToolRegistryEntry[] {
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
    // Goalless sessions must not see this tool AT ALL: a completion-marker
    // in the function list gets spuriously called at turn end even by strong
    // models at high effort (observed with gpt-5.6-sol) — wording does not
    // beat the trained close-out-the-task prior. The enabled() gate removes
    // it from the provider's tool list until a goal is active (re-evaluated
    // every model call, so /goal mid-session takes effect immediately), and
    // there is deliberately no promptSnippet since the static system prompt
    // cannot track goal state. Goal turns inject full usage guidance
    // separately (goal/prompts.ts), so the legitimate path loses nothing.
    enabled: () => store.isActive(),
    async execute(args): Promise<{ content: string; isError?: boolean }> {
      const goal = store.snapshot();
      if (!goal) return { content: "No active goal to update.", isError: true };
      const status = String(args.status ?? "").toLowerCase();
      if (status === "complete") {
        store.markComplete();
        // The current turn's token usage is only reported at turn_end (after
        // tools run), so goal.tokensUsed is necessarily stale here. The harness
        // reports the accurate final total to the user once the run settles.
        return { content: "Goal marked complete." };
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

  return [updateGoal];
}
