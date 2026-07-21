import { classifyTask } from "../agent/task-classifier.js";
import { classifyTaskSize } from "../agent/task-size.js";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import { DiscoveryBarrier } from "../agent/discovery-barrier.js";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import {
  buildCompletionSelfCheckReminder,
  buildEditRetryEscalationReminder,
  buildSmallTaskHint,
  buildWorkflowPhaseReminder,
} from "../prompt/reminders.js";
import { largeImplementationTaskReminder, orchestrationRequestReminder, reminderForTaskType, userNamedModelReminder } from "../prompt/task-reminders.js";
import { captureGitBaseline, detectRunChanges, type RunChangeSummary } from "../agent/change-tracker.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "./workflow.js";
import type { BeforeToolCallHookContext, TurnHookState, TurnHooks } from "./hooks.js";
import type { ParsedToolCall, ToolResult } from "../types.js";
import { resolve as resolvePath } from "node:path";
import { traceEvent } from "../debug-trace.js";
import { builtinAgentProfiles, discoverAgentProfiles, hasWriteWorktreeProfile } from "../agent/profiles.js";
import { buildSubagentLifecycleReminder } from "../agent/subagent-lifecycle-reminder.js";

export function createDefaultHooks(): TurnHooks[] {
  return [
    {
      async beforeTurn(ctx) {
        // Git ground truth for the completion gate: tool-metadata bookkeeping
        // misses bash-written files and subagent worktree merges; a dirty-state
        // baseline at run start makes the run's real footprint observable.
        if (ctx.state.gitBaseline === undefined) {
          ctx.state.gitBaseline = await captureGitBaseline(ctx.cwd);
        }
        const taskType = classifyTask(ctx.input);
        ctx.state.taskType = taskType;
        ctx.state.governor = new ExecutionGovernor(taskType);
        ctx.state.discoveryBarrier = new DiscoveryBarrier({
          cwd: ctx.cwd,
          input: ctx.input,
          enabled: taskType === "repo_orientation",
        });
        const taskReminder = reminderForTaskType(taskType, {
          // Only parent agents carry the delegation tools; the nudge must
          // never reach a child that cannot spawn anything.
          canDelegate: ctx.agent.hasToolAvailable("spawn_agent"),
        });
        if (taskReminder) {
          ctx.queueReminder(taskReminder);
        }
        // User named the mechanism ("agent team" / workflow / 编排): remind at
        // the decision turn, where it outweighs the parallel-spawns prior.
        const orchestrationReminder = orchestrationRequestReminder(
          ctx.input,
          ctx.agent.hasToolAvailable("run_workflow"),
        );
        if (orchestrationReminder) {
          ctx.queueReminder(orchestrationReminder);
          // The large-change checkpoint must not re-offer spawn_agent in a
          // turn where this reminder just forbade it (design §3).
          ctx.state.orchestrationReminderSent = true;
        }
        // User named a configured model ("gpt 5.6 sol"): resolve it against
        // the routable catalog and hand over the exact id at the decision
        // point — never let the parent retype ids from priors (v3.6).
        const namedModelReminder = userNamedModelReminder(
          ctx.input,
          ctx.agent.listRoutableModels?.(),
          ctx.agent.hasToolAvailable("spawn_agent"),
        );
        if (namedModelReminder) {
          ctx.queueReminder(namedModelReminder);
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
        // Background-task truth at turn start: completions that landed while
        // the agent was idle (or during another session's turn) reach the
        // model here; the same state-change gate prevents duplicates with the
        // beforeContinuation emission (background-tasks design §2.3a).
        const backgroundTaskReminder = ctx.agent.consumeBackgroundTaskReminder?.();
        if (backgroundTaskReminder) {
          ctx.queueReminder(backgroundTaskReminder);
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
        ctx.state.toolUsed = true;
        const arbitration = arbitrateToolCall(ctx.toolCall);
        const toolCall = { ...arbitration.toolCall, ...(arbitration.note ? { arbiterNote: arbitration.note } : {}) };
        ctx.replaceToolCall(toolCall);
        ctx.state.governor?.beforeToolCall(toolCall);
        // Large-change checkpoint (large-task-delegation design §1): the
        // first mutation of the turn is the decision point — exploration is
        // over, nothing has been edited yet.
        if (isMutationTool(toolCall.name)) {
          maybeQueueLargeTaskNudge(ctx);
        }
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
          ctx.state.appliedEditCount = (ctx.state.appliedEditCount ?? 0) + 1;
        }
        // Large-task breadth evidence (design §1): only files actually READ.
        // Search results contribute nothing — one glob returns up to 100
        // match paths and would saturate any threshold instantly (review
        // blocker). Bash-parsed reads (cat/head/sed -n) carry relative
        // paths, so resolve against cwd before dedup.
        if (!ctx.result.isError && ctx.result.metadata?.kind === "read") {
          const path = typeof ctx.result.metadata.path === "string" ? ctx.result.metadata.path : undefined;
          if (path) {
            (ctx.state.exploredFiles ??= new Set()).add(resolvePath(ctx.cwd, path));
          }
        }
        // Removed: active verification tracking. The previous design nagged the
        // model every turn until it ran a recognised verification command, and
        // narrowly accepted only test/lint commands — which meant ad-hoc python
        // checks did not count, the nag never cleared, and reasoning models
        // (DeepSeek v4-pro with hex-blindness) spiraled trying to "prove" the
        // edit was correct. CC's approach is the opposite: verify when there
        // is something real to verify, say so explicitly when there isn't, and
        // trust the model to judge. We follow that.
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
        // Background-task truth: state-change gated inside the agent (a task
        // started/finished/killed since the last emission), so a mid-turn
        // completion reaches the model without stacking per-call duplicates
        // (background-tasks design §2.3a).
        const taskReminder = ctx.agent.consumeBackgroundTaskReminder?.();
        if (taskReminder) {
          ctx.queueReminder(taskReminder);
        }
        // Routing detector note (model-routing design §6): rides the same
        // channel as the lifecycle reminder, once per session. Consuming also
        // closes the per-fan-out counting window.
        const routingReminder = ctx.agent.consumePendingRoutingReminder?.();
        if (routingReminder) {
          ctx.queueReminder(routingReminder);
        }

        if (ctx.state.taskType === "security_investigation" && ctx.state.evidenceTracker?.isCoreCoverageComplete()) {
          ctx.requestTextOnlyTurn(
            "Core security investigation evidence has been collected. Summarize the findings instead of continuing with more tool calls.",
          );
          return;
        }

        // Verification reminders intentionally removed. See afterToolCall.
      },
      async afterTurn(ctx) {
        // Verification force-continuation removed. The model decides whether
        // verification is meaningful for the task, per the system prompt.
        //
        // Completion self-check gate: when a run that changed code is about
        // to end (this hook only runs on final, no-tool-call turns), remind
        // the model ONCE to re-read the original request before finishing.
        // Unlike the removed verification gate it never repeats — the model
        // is explicitly told a confirming final answer ends the run — so the
        // "prove it" spiral that killed the old design cannot start.
        if (ctx.state.completionGateFired) return;
        // Tools are frozen: the model could not act on anything the check
        // surfaces, so another turn is pure token burn.
        if (ctx.state.forceTextOnlyReason) return;
        // Subagents hand off to a parent that does its own closing pass, and
        // worktree profiles explicitly forbid the very actions a completion
        // check would suggest. The parent's gate still covers their merged
        // changes via the git baseline below.
        if (ctx.agent.role === "subagent") return;

        // Change detection: tool metadata first (cheap), then git ground
        // truth — which also catches bash-written files and subagent
        // worktree merges. Gate only runs git when the run actually used
        // tools, so external repo churn cannot hijack a pure Q&A turn.
        let changes: RunChangeSummary | null = null;
        if (ctx.state.toolUsed && ctx.state.gitBaseline) {
          changes = await detectRunChanges(ctx.cwd, ctx.state.gitBaseline);
        }
        const changedSomething = !!ctx.state.codeChanged || (changes !== null && changes.changedFiles.length > 0);
        if (!changedSomething) return;

        ctx.state.completionGateFired = true;
        ctx.state.forceContinuationReason = "completion_self_check";
        ctx.queueReminder(buildCompletionSelfCheckReminder({
          modifiedExistingTests: changes?.modifiedExistingTests,
        }));
        traceEvent("completion_gate_fired", {
          turnCount: ctx.state.turnCount,
          changedFiles: changes?.changedFiles.length,
          modifiedExistingTests: changes?.modifiedExistingTests.length,
        });
      },
    },
  ];
}

function markCodeChanged(state: TurnHookState): void {
  state.codeChanged = true;
}

// Large-task delegation checkpoint (large-task-delegation design §1-3).
const BREADTH_FILES = 8;
const BREADTH_FILES_WITH_PLAN = 5;
const BREADTH_TODOS = 6;

function maybeQueueLargeTaskNudge(ctx: BeforeToolCallHookContext): void {
  // Evaluated exactly once per turn, at the first mutation — fired or not
  // (mid-implementation re-detection is out of scope by design §4).
  if (ctx.state.largeTaskCheckpointDone) return;
  ctx.state.largeTaskCheckpointDone = true;

  const agent = ctx.agent;
  const taskType = ctx.state.taskType;
  const exploredFiles = ctx.state.exploredFiles?.size ?? 0;
  const pendingTodos = agent.getTodos?.()
    ?.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length ?? 0;
  const threshold = pendingTodos >= BREADTH_TODOS ? BREADTH_FILES_WITH_PLAN : BREADTH_FILES;

  // Gate order: cheap checks first; the profile discovery (filesystem) runs
  // only when everything else already passed.
  const suppressedBy = agent.largeTaskNudgeConsumed ? "session_latch"
    : (taskType === "code_review" || taskType === "security_investigation") ? "task_type"
    : !agent.hasToolAvailable("spawn_agent") ? "no_spawn_tool"
    : (agent.activeSubAgentCount?.() ?? 0) > 0 ? "active_children"
    : agent.hasRunningWorkflow?.() ? "running_workflow"
    : exploredFiles < threshold ? "below_threshold"
    : !writeWorktreeSurfaceAvailable(ctx.cwd) ? "no_write_profile"
    : undefined;

  traceEvent("delegation_detector", {
    fired: suppressedBy === undefined,
    exploredFiles,
    pendingTodos,
    threshold,
    taskType: taskType ?? "unknown",
    ...(suppressedBy ? { suppressedBy } : {}),
  });
  if (suppressedBy !== undefined) return;

  agent.largeTaskNudgeConsumed = true;
  ctx.queueReminder(largeImplementationTaskReminder({
    exploredFiles,
    pendingTodos,
    appliedEdits: ctx.state.appliedEditCount ?? 0,
    orchestrationRequested: ctx.state.orchestrationReminderSent === true,
  }));
}

function writeWorktreeSurfaceAvailable(cwd: string): boolean {
  try {
    const discovered = discoverAgentProfiles(cwd, "both").profiles;
    return hasWriteWorktreeProfile([...builtinAgentProfiles(), ...discovered]);
  } catch {
    return hasWriteWorktreeProfile(builtinAgentProfiles());
  }
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
    || name === "close_agent";
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
