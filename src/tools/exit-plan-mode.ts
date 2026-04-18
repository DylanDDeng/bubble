/**
 * exit_plan_mode tool - proposes a plan, awaits user approval, and (on approve) flips the
 * agent out of plan mode so subsequent turns may execute it.
 *
 * The tool is read-only from the agent's perspective; the side effects (prompting the user,
 * flipping mode) happen via the injected PlanController.
 */

import type { AgentMode, PlanDecision, ToolRegistryEntry, ToolResult } from "../types.js";

export interface PlanController {
  /** Ask the user to approve/reject/edit the proposed plan. */
  requestApproval(plan: string): Promise<PlanDecision>;
  /** Switch the agent's mode. Called after an approval so the next turn runs unconstrained. */
  setMode(mode: AgentMode): void;
}

export function createExitPlanModeTool(controller: PlanController): ToolRegistryEntry {
  return {
    name: "exit_plan_mode",
    readOnly: true,
    description:
      "Call this after finishing investigation in plan mode to present a concrete plan to the user. " +
      "The user may approve (optionally with edits) or reject. On approval, the agent is switched out of plan mode and may begin execution. " +
      "On rejection, remain in plan mode and iterate on the plan.",
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
