import { classifyTask } from "../agent/task-classifier.js";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import {
  buildFinalizeOpportunityReminder,
  buildTaskSummaryReminder,
  buildVerificationFailureReminder,
  buildVerificationReminder,
  buildWorkflowPhaseReminder,
} from "../prompt/reminders.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "./workflow.js";
import type { TurnHookState, TurnHooks } from "./hooks.js";
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
          markCodeChanged(ctx.state);
        } else if (ctx.state.codeChanged && isVerificationAttempt(ctx.toolCall, ctx.result)) {
          ctx.state.verificationAttempted = true;
          if (isSuccessfulToolResult(ctx.result)) {
            ctx.state.verificationCompleted = true;
            ctx.state.verificationFailed = false;
          } else {
            ctx.state.verificationCompleted = false;
            ctx.state.verificationFailed = true;
            ctx.state.finalizeReminderQueued = false;
          }
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
        if (changedThisTurn && !ctx.state.verificationAttempted && !ctx.state.verificationCompleted && !ctx.state.verificationReminderQueued) {
          ctx.state.verificationReminderQueued = true;
          ctx.queueReminder(buildVerificationReminder(
            "The previous turn changed files and no verification evidence has been observed yet.",
          ));
        }
        if (ctx.state.codeChanged && ctx.state.verificationFailed && !ctx.state.verificationFailureReminderQueued) {
          ctx.state.verificationFailureReminderQueued = true;
          ctx.queueReminder(buildVerificationFailureReminder(
            "A verification command or runtime check was attempted after file changes, but it did not pass.",
          ));
        }
        if (ctx.state.codeChanged && ctx.state.verificationCompleted && !ctx.state.finalizeReminderQueued) {
          ctx.state.finalizeReminderQueued = true;
          ctx.queueReminder(buildFinalizeOpportunityReminder(
            "A relevant verification command or runtime check passed after file changes.",
          ));
        }
      },
      afterTurn(ctx) {
        if (ctx.state.codeChanged && ctx.state.verificationFailed && !ctx.state.verificationFailureReminderSent) {
          ctx.state.verificationFailureReminderSent = true;
          ctx.state.forceContinuationReason = "Files were changed, but the latest verification evidence failed.";
          ctx.queueReminder(buildVerificationFailureReminder(ctx.state.forceContinuationReason));
          return;
        }
        if (ctx.state.codeChanged && !ctx.state.verificationAttempted && !ctx.state.verificationCompleted && !ctx.state.finalVerificationReminderSent) {
          ctx.state.finalVerificationReminderSent = true;
          ctx.state.forceContinuationReason = "Files were changed but no verification evidence was observed before the final answer.";
          ctx.queueReminder(buildVerificationReminder(ctx.state.forceContinuationReason));
        }
      },
    },
  ];
}

function markCodeChanged(state: TurnHookState): void {
  state.codeChanged = true;
  state.verificationAttempted = false;
  state.verificationCompleted = false;
  state.verificationFailed = false;
  state.verificationReminderQueued = false;
  state.finalVerificationReminderSent = false;
  state.verificationFailureReminderQueued = false;
  state.verificationFailureReminderSent = false;
  state.finalizeReminderQueued = false;
}

function isCodeWriteResult(_toolCall: ParsedToolCall, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "command_error") {
    return false;
  }
  return result.metadata?.kind === "write" || result.metadata?.kind === "edit";
}

function isSuccessfulToolResult(result: ToolResult): boolean {
  if (result.isError) {
    return false;
  }
  return result.status !== "blocked" && result.status !== "command_error" && result.status !== "timeout";
}

function isVerificationAttempt(toolCall: ParsedToolCall, result: ToolResult): boolean {
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
    || /\b(python3?|uv\s+run\s+python3?|poetry\s+run\s+python3?)\s+(-m\s+)?(pytest|unittest|ruff|mypy)\b/.test(normalized)
    || /\b(make|cmake)\s+(test|check)\b/.test(normalized)
    || /\b(vitest|tsc|pytest|ruff|mypy|ctest|cargo\s+test|go\s+test|swift\s+test|mvn\s+test|gradle\s+test|\.\/gradlew\s+test)\b/.test(normalized);
}
