import { classifyTask } from "../agent/task-classifier.js";
import { classifyTaskSize } from "../agent/task-size.js";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import { DiscoveryBarrier } from "../agent/discovery-barrier.js";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import {
  buildEditRetryEscalationReminder,
  buildSmallTaskHint,
  buildTaskSummaryReminder,
  buildWorkflowPhaseReminder,
} from "../prompt/reminders.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "./workflow.js";
import type { TurnHookState, TurnHooks } from "./hooks.js";
import type { ParsedToolCall, ToolResult } from "../types.js";
import { buildSubagentLifecycleReminder } from "../agent/subagent-lifecycle-reminder.js";

export function createDefaultHooks(): TurnHooks[] {
  return [
    {
      beforeTurn(ctx) {
        const taskType = classifyTask(ctx.input);
        ctx.state.taskType = taskType;
        ctx.state.governor = new ExecutionGovernor(taskType);
        ctx.state.discoveryBarrier = new DiscoveryBarrier({
          cwd: ctx.cwd,
          input: ctx.input,
          enabled: taskType === "repo_orientation",
        });
        const taskReminder = reminderForTaskType(taskType);
        if (taskReminder) {
          ctx.queueReminder(taskReminder);
        }
        // Small-task hint: counterweight to the default protocol's exploration
        // bias, only fires once per run on focused one-shot requests like
        // "写个 HTML 介绍元旦". Don't issue for the same input twice.
        if (!ctx.state.smallTaskHintSent && classifyTaskSize(ctx.input) === "small") {
          ctx.state.smallTaskHintSent = true;
          ctx.queueReminder(buildSmallTaskHint());
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
        if (ctx.state.taskType === "security_investigation" && ctx.state.evidenceTracker && ctx.state.governor) {
          const coverage = ctx.state.evidenceTracker.snapshot();
          const phase = resolveWorkflowPhase({
            coreCoverageComplete: ctx.state.evidenceTracker.isCoreCoverageComplete(),
            searchFrozen: false,
          });
          ctx.state.workflowPhase = phase;
          const summary = formatCoverageSummary(coverage);
          const key = `${phase}:${ctx.state.evidenceTracker.key()}:0`;
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
        const toolCall = { ...arbitration.toolCall, ...(arbitration.note ? { arbiterNote: arbitration.note } : {}) };
        ctx.replaceToolCall(toolCall);
        ctx.state.governor?.beforeToolCall(toolCall);
        const blockedResult = ctx.state.discoveryBarrier?.beforeToolCall(toolCall);
        if (blockedResult) ctx.blockToolCall(blockedResult);
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
        ctx.state.discoveryBarrier?.afterToolCall(ctx.toolCall, ctx.result);
        // Edit/write retry-escalation: models can spiral on "identical content"
        // or "not found" errors. Nudge them to re-ground or switch strategy.
        if (isMutationTool(ctx.toolCall.name) && ctx.result.isError) {
          if (ctx.toolCall.name === "edit" && ctx.result.status === "no_match" && ctx.result.metadata?.kind === "edit") {
            const path = typeof ctx.result.metadata.path === "string" ? ctx.result.metadata.path : "";
            const reminded = ctx.state.editNoMatchReminderPaths ?? (ctx.state.editNoMatchReminderPaths = []);
            if (path && !reminded.includes(path)) {
              reminded.push(path);
              const summary = ctx.result.content.split("\n")[0] || "";
              ctx.queueReminder(buildEditRetryEscalationReminder(
                `Edit oldText did not match ${path}. ${summary}`,
              ));
            }
          }
          const hash = hashEditCall(ctx.toolCall);
          const history: string[] = ctx.state.recentEditFailures ?? (ctx.state.recentEditFailures = []);
          history.push(hash);
          // Keep last 4 entries.
          if (history.length > 4) history.shift();
          const len = history.length;
          if (len >= 2 && history[len - 1] === history[len - 2] && !ctx.state.editRetryReminderSent) {
            ctx.state.editRetryReminderSent = true;
            const summary = ctx.result.content.split("\n")[0] || "";
            ctx.queueReminder(buildEditRetryEscalationReminder(
              `Last failure: ${ctx.toolCall.name} on the same target with identical arguments. ${summary}`,
            ));
          }
        } else if (isMutationTool(ctx.toolCall.name) && !ctx.result.isError) {
          // Successful mutation resets the dedup state so a later, unrelated
          // failure won't fire the reminder spuriously.
          ctx.state.recentEditFailures = [];
          ctx.state.editNoMatchReminderPaths = [];
          ctx.state.editRetryReminderSent = false;
        }
        // Redundant-Read detection moved into the read tool itself: it now
        // returns a FILE_UNCHANGED_STUB (or auto-advances to the next page)
        // when the same args land on an unchanged file. Hook-level reminder
        // is removed to avoid duplicate signals and to let the structural
        // dedup do the work.
        if (isCodeWriteResult(ctx.toolCall, ctx.result)) {
          markCodeChanged(ctx.state);
        }
        // Removed: active verification tracking. The previous design nagged the
        // model every turn until it ran a recognised verification command, and
        // narrowly accepted only test/lint commands — which meant ad-hoc python
        // checks did not count, the nag never cleared, and reasoning models
        // (DeepSeek v4-pro with hex-blindness) spiraled trying to "prove" the
        // edit was correct. CC's approach is the opposite: verify when there
        // is something real to verify, say so explicitly when there isn't, and
        // trust the model to judge. We follow that.
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
        if (hasSubagentLifecycleActivity(ctx.toolCalls, ctx.toolResults)) {
          const reminder = buildSubagentLifecycleReminder(ctx.agent.listSubAgents(), ctx.toolResults);
          if (reminder) {
            ctx.queueReminder(reminder);
          }
        }

        if (ctx.state.taskType === "security_investigation" && ctx.state.evidenceTracker?.isCoreCoverageComplete()) {
          ctx.requestTextOnlyTurn(
            "Core security investigation evidence has been collected. Summarize the findings instead of continuing with more tool calls.",
          );
          return;
        }

        // Verification reminders intentionally removed. See afterToolCall.
      },
      afterTurn() {
        // Verification force-continuation removed. The model decides whether
        // verification is meaningful for the task, per the system prompt.
      },
    },
  ];
}

function markCodeChanged(state: TurnHookState): void {
  state.codeChanged = true;
}

function isCodeWriteResult(_toolCall: ParsedToolCall, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "cancelled" || result.status === "command_error") {
    return false;
  }
  return result.metadata?.kind === "write" || result.metadata?.kind === "edit" || result.metadata?.kind === "patch";
}

function isMutationTool(name: string): boolean {
  return name === "edit" || name === "write";
}

function hasSubagentLifecycleActivity(
  toolCalls: Array<ParsedToolCall & { arbiterNote?: string }>,
  toolResults: ToolResult[],
): boolean {
  return toolCalls.some((toolCall) => isSubagentLifecycleTool(toolCall.name))
    || toolResults.some((result) => result.metadata?.kind === "subagent");
}

function isSubagentLifecycleTool(name: string): boolean {
  return name === "spawn_agent"
    || name === "wait_agent"
    || name === "send_input"
    || name === "close_agent"
    || name === "task";
}

function hashEditCall(toolCall: ParsedToolCall): string {
  // Cheap fingerprint that identifies "same edit/write call". JSON of the
  // sorted parsed args is good enough — we only need stable equality between
  // identical calls, not cryptographic strength.
  try {
    return `${toolCall.name}:${stableStringify(toolCall.parsedArgs)}`;
  } catch {
    return `${toolCall.name}:${toolCall.arguments}`;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
