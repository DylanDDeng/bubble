import { buildModifiedTestsDisclosure } from "../prompt/reminders.js";
import { orchestrationRequestReminder, userNamedModelReminder } from "../prompt/task-reminders.js";
import { captureGitBaseline, detectRunChanges } from "../agent/change-tracker.js";
import type { TurnHooks } from "./hooks.js";
import type { ParsedToolCall, ToolResult } from "../types.js";
import { buildSubagentLifecycleReminder } from "../agent/subagent-lifecycle-reminder.js";

/**
 * Default hooks: infrastructure and information only.
 *
 * The cognitive-governance layer that used to live here (task classifier,
 * step-budget governor, discovery barrier, evidence tracker, bash-search
 * arbitration, delegation nudge, completion self-check) was removed — see
 * docs/harness-thinning.md. The TurnHooks mechanism itself stays, pi-style:
 * hosts may install their own policies, the core ships none.
 *
 * What remains, and why it passes the ruler in that document:
 * - resident-history compaction calls (infrastructure)
 * - background-task and subagent-lifecycle reminders (facts the model
 *   cannot otherwise see)
 * - orchestrationRequestReminder (deliberately retained policy: amplifies
 *   the user's EXPLICIT orchestration request at the decision turn)
 * - userNamedModelReminder (deterministic catalog resolution of a model the
 *   user named — information the model would otherwise retype from priors)
 * - modified-existing-tests disclosure (git ground truth: bash writes and
 *   subagent worktree merges do not appear in the model's own tool memory)
 */
export function createDefaultHooks(): TurnHooks[] {
  return [
    {
      async beforeTurn(ctx) {
        // Git ground truth for the tests-touched disclosure: tool-metadata
        // bookkeeping misses bash-written files and subagent worktree merges;
        // a dirty-state baseline at run start makes the run's real footprint
        // observable.
        if (ctx.state.gitBaseline === undefined) {
          ctx.state.gitBaseline = await captureGitBaseline(ctx.cwd);
        }
        // User named the mechanism ("agent team" / workflow / 编排): remind at
        // the decision turn, where it outweighs the parallel-spawns prior.
        const orchestrationReminder = orchestrationRequestReminder(
          ctx.input,
          ctx.agent.hasToolAvailable("run_workflow"),
        );
        if (orchestrationReminder) {
          ctx.queueReminder(orchestrationReminder);
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
        // Background-task truth at turn start: completions that landed while
        // the agent was idle (or during another session's turn) reach the
        // model here; the same state-change gate prevents duplicates with the
        // beforeContinuation emission (background-tasks design §2.3a).
        const backgroundTaskReminder = ctx.agent.consumeBackgroundTaskReminder?.();
        if (backgroundTaskReminder) {
          ctx.queueReminder(backgroundTaskReminder);
        }
        ctx.agent.compactResidentHistory();
      },
      beforeModelCall(ctx) {
        ctx.agent.compactResidentHistory();
      },
      afterTurn(ctx) {
        ctx.agent.compactResidentHistory();
      },
    },
    {
      beforeToolCall(ctx) {
        ctx.state.toolUsed = true;
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
      },
      async afterTurn(ctx) {
        // Modified-existing-tests disclosure: pure information, delivered at
        // most once, only when this run touched test files that already
        // existed at run start. Forcing one continuation turn is the only way
        // a final-turn fact can reach the model at all. The old completion
        // self-check ("re-read the request...") was removed with the
        // governance layer; this survives it because the underlying fact
        // comes from git, not from the model's own tool history.
        if (ctx.state.testsTouchedDisclosed) return;
        // Tools are frozen: the model could not act on the disclosure, so
        // another turn is pure token burn.
        if (ctx.state.forceTextOnlyReason) return;
        // Subagents hand off to a parent whose own disclosure covers their
        // merged changes via the git baseline.
        if (ctx.agent.role === "subagent") return;
        // Only attribute git changes to runs that actually used tools, so
        // external repo churn cannot hijack a pure Q&A turn.
        if (!ctx.state.toolUsed || !ctx.state.gitBaseline) return;

        const changes = await detectRunChanges(ctx.cwd, ctx.state.gitBaseline);
        if (!changes || changes.modifiedExistingTests.length === 0) return;

        ctx.state.testsTouchedDisclosed = true;
        ctx.state.forceContinuationReason = "tests_touched_disclosure";
        ctx.queueReminder(buildModifiedTestsDisclosure(changes.modifiedExistingTests));
      },
    },
  ];
}

function hasSubagentLifecycleActivity(
  toolCalls: ParsedToolCall[],
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
