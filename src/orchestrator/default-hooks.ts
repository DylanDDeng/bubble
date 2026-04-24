import { classifyTask } from "../agent/task-classifier.js";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import { buildTaskSummaryReminder, buildWorkflowPhaseReminder } from "../prompt/reminders.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "./workflow.js";
import type { TurnHooks } from "./hooks.js";

export function createDefaultHooks(): TurnHooks[] {
  return [
    {
      beforeTurn(ctx) {
        const taskType = classifyTask(ctx.input);
        ctx.state.taskType = taskType;
        ctx.state.governor = new ExecutionGovernor(taskType);
        if (taskType === "security_investigation") {
          ctx.state.evidenceTracker = new EvidenceTracker();
          ctx.state.workflowPhase = "investigate";
          ctx.state.workflowKey = "";
        }
        for (const reminder of ctx.state.governor.consumePendingReminders()) {
          ctx.queueReminder(reminder);
        }
        ctx.agent.compactResidentHistory();
      },
      beforeModelCall(ctx) {
        ctx.agent.compactResidentHistory();
        if (ctx.state.governor) {
          ctx.toolEntries = ctx.state.governor.filterToolDefinitions(ctx.toolEntries);
        }
        if (ctx.state.taskType === "security_investigation" && ctx.state.evidenceTracker && ctx.state.governor) {
          const coverage = ctx.state.evidenceTracker.snapshot();
          const phase = resolveWorkflowPhase({
            coreCoverageComplete: ctx.state.evidenceTracker.isCoreCoverageComplete(),
            searchFrozen: ctx.state.governor.snapshot().searchFrozen,
          });
          ctx.state.workflowPhase = phase;
          const summary = formatCoverageSummary(coverage);
          const key = `${phase}:${ctx.state.evidenceTracker.key()}:${ctx.state.governor.snapshot().searchFrozen ? "1" : "0"}`;
          if (ctx.state.workflowKey !== key) {
            ctx.state.workflowKey = key;
            ctx.queueReminder(buildWorkflowPhaseReminder({
              phase,
              covered: summary.covered,
              pending: summary.pending,
            }));
          }
        }
      },
      afterTurn(ctx) {
        ctx.agent.compactResidentHistory();
      },
    },
    {
      beforeToolCall(ctx) {
        const arbitration = arbitrateToolCall(ctx.toolCall);
        ctx.replaceToolCall({ ...arbitration.toolCall, ...(arbitration.note ? { arbiterNote: arbitration.note } : {}) });
        const decision = ctx.state.governor?.beforeToolCall(ctx.toolCall);
        if (decision?.blockedResult) {
          ctx.blockToolCall(decision.blockedResult);
        }
      },
      afterToolCall(ctx) {
        if (ctx.toolCall.arbiterNote) {
          ctx.replaceResult({
            ...ctx.result,
            metadata: {
              ...ctx.result.metadata,
              arbiterNote: ctx.toolCall.arbiterNote,
            },
          });
        }
        ctx.state.evidenceTracker?.observe(ctx.toolCall, ctx.result);
        ctx.state.governor?.afterToolResult(ctx.toolCall, ctx.result);
        if (ctx.toolCall.name === "task") {
          ctx.queueReminder(buildTaskSummaryReminder());
        }
        if (ctx.state.governor) {
          for (const reminder of ctx.state.governor.consumePendingReminders()) {
            ctx.queueReminder(reminder);
          }
        }
      },
      beforeContinuation(ctx) {
        if (ctx.state.taskType === "security_investigation" && ctx.state.evidenceTracker?.isCoreCoverageComplete()) {
          ctx.requestTextOnlyTurn(
            "Core security investigation evidence has been collected. Summarize the findings instead of continuing with more tool calls.",
          );
          return;
        }

        const allSearchResultsWereLowSignal = ctx.toolCalls.length > 0
          && ctx.toolCalls.every((toolCall) => ["glob", "grep", "bash", "web_search", "web_fetch"].includes(toolCall.name))
          && ctx.toolResults.every((result) => result.status === "no_match" || result.status === "blocked");
        if (ctx.state.governor?.snapshot().searchFrozen && allSearchResultsWereLowSignal) {
          ctx.requestTextOnlyTurn(
            "Search continuation has become low-yield. Summarize the strongest evidence already collected instead of continuing broad exploration.",
          );
        }
      },
    },
  ];
}
