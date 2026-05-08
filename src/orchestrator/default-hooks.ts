import { classifyTask } from "../agent/task-classifier.js";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import { buildTaskSummaryReminder, buildVerificationReminder, buildWorkflowPhaseReminder } from "../prompt/reminders.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "./workflow.js";
import type { TurnHooks } from "./hooks.js";
import type { ParsedToolCall, ToolResult } from "../types.js";

export function createDefaultHooks(): TurnHooks[] {
  return [
    {
      beforeTurn(ctx) {
        const taskType = classifyTask(ctx.input);
        ctx.state.taskType = taskType;
        ctx.state.governor = new ExecutionGovernor(taskType);
        const taskReminder = reminderForTaskType(taskType);
        if (taskReminder) {
          ctx.queueReminder(taskReminder);
        }
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
        if (isCodeWriteResult(ctx.toolCall, ctx.result)) {
          ctx.state.codeChanged = true;
        } else if (ctx.state.codeChanged && isVerificationResult(ctx.toolCall, ctx.result)) {
          ctx.state.verificationCompleted = true;
        }
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
        const changedThisTurn = ctx.toolResults.some((result) => result.metadata?.kind === "write" || result.metadata?.kind === "edit");
        if (changedThisTurn && !ctx.state.verificationCompleted && !ctx.state.verificationReminderQueued) {
          ctx.state.verificationReminderQueued = true;
          ctx.queueReminder(buildVerificationReminder(
            "The previous turn changed files and no verification evidence has been observed yet.",
          ));
        }
      },
      afterTurn(ctx) {
        if (ctx.state.codeChanged && !ctx.state.verificationCompleted && !ctx.state.finalVerificationReminderSent) {
          ctx.state.finalVerificationReminderSent = true;
          ctx.state.forceContinuationReason = "Files were changed but no verification evidence was observed before the final answer.";
          ctx.queueReminder(buildVerificationReminder(ctx.state.forceContinuationReason));
        }
      },
    },
  ];
}

function isCodeWriteResult(_toolCall: ParsedToolCall, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "command_error") {
    return false;
  }
  return result.metadata?.kind === "write" || result.metadata?.kind === "edit";
}

function isVerificationResult(toolCall: ParsedToolCall, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "command_error") {
    return false;
  }
  if (toolCall.name === "lsp") {
    return true;
  }
  if (toolCall.name !== "bash") {
    return false;
  }
  const command = typeof result.metadata?.command === "string"
    ? result.metadata.command
    : typeof toolCall.parsedArgs.command === "string"
      ? toolCall.parsedArgs.command
      : "";
  return isVerificationCommand(command);
}

function isVerificationCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|build|typecheck|lint|check|tsc)|exec\s+tsc)\b/.test(normalized)
    || /\b(npx|pnpm\s+exec|bunx)\s+(vitest|tsc|eslint|playwright)\b/.test(normalized)
    || /\b(vitest|tsc|pytest|ruff|cargo\s+test|go\s+test|swift\s+test)\b/.test(normalized);
}
