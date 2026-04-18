/**
 * exit_plan_mode tool - proposes a plan, awaits user approval, and (on approve) flips the
 * agent out of plan mode so subsequent turns may execute it.
 *
 * The tool is read-only from the agent's perspective; the side effects (prompting the user,
 * flipping mode) happen via the injected PlanController.
 */

import type { PermissionMode, PlanDecision, ToolRegistryEntry, ToolResult } from "../types.js";

export interface PlanController {
  /** Reads the current permission mode (used to gate the tool). */
  getMode: () => PermissionMode;
  /** Ask the user to approve/reject/edit the proposed plan. */
  requestApproval(plan: string): Promise<PlanDecision>;
  /** Switch the agent's mode. Called after an approval so the next turn runs unconstrained. */
  setMode(mode: PermissionMode): void;
}

export function createExitPlanModeTool(controller: PlanController): ToolRegistryEntry {
  return {
    name: "exit_plan_mode",
    readOnly: true,
    description:
      "ONLY call this tool when the harness has told you (via a <system-reminder>) that plan mode is ACTIVE. " +
      "Do NOT call it during ordinary work — in default mode you should just use the regular tools directly. " +
      "In plan mode: after investigating, call this with a concrete step-by-step plan so the user can approve, edit, or reject. " +
      "Approval automatically switches the agent out of plan mode.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "The plan to present to the user. Should be concrete, step-by-step, and cover all changes you intend to make.",
        },
      },
      required: ["plan"],
    },
    async execute(args): Promise<ToolResult> {
      // Hard gate: this tool is a no-op outside plan mode. Without this check some
      // models call it during normal work (misled by the word "plan" in the schema),
      // which pops a confusing approval dialog to the user.
      if (controller.getMode() !== "plan") {
        return {
          content:
            "Error: exit_plan_mode is only valid while plan mode is active. " +
            "You are currently NOT in plan mode — proceed with the user's request directly using the regular tools.",
          isError: true,
        };
      }

      const plan = typeof args.plan === "string" ? args.plan.trim() : "";
      if (!plan) {
        return { content: "Error: plan is required and must be a non-empty string", isError: true };
      }

      let decision: PlanDecision;
      try {
        decision = await controller.requestApproval(plan);
      } catch (err: any) {
        return {
          content: `Error requesting plan approval: ${err?.message || String(err)}`,
          isError: true,
        };
      }

      if (decision.action === "approve") {
        controller.setMode("default");
        const finalPlan = decision.plan.trim() || plan;
        const edited = finalPlan !== plan;
        return {
          content:
            `User approved the plan${edited ? " (with edits)" : ""}. ` +
            `Agent mode has been switched to default — you may now execute the plan using any tools. ` +
            `Approved plan:\n\n${finalPlan}`,
        };
      }

      const reason = decision.reason?.trim();
      return {
        content:
          `User rejected the plan. Remain in plan mode and revise your approach. ` +
          (reason ? `Reason: ${reason}` : "No reason provided; ask for clarification or gather more context."),
      };
    },
  };
}
