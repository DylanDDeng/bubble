/**
 * Delegation policy section for the parent agent's system prompt.
 *
 * Two-sided by design (review 2026-06-12): positive triggers are quantified
 * and read-only-scoped, negative clauses get equal weight — the user's hard
 * constraint is "proactive, but never delegate-everything". Gated on the
 * delegation tools being present, so child agents (whose tool sets never
 * include spawn_agent/run_workflow) never see it.
 */

const DELEGATION_POLICY = `## Delegation policy (subagents)

You can delegate work two ways: a single background subagent (spawn_agent),
or an orchestration script coordinating many subagents (run_workflow).
Delegate deliberately, not by default.

Explicit requests win, before any other rule: when the user names a
coordinated multi-agent run in any phrasing — a workflow, an orchestration,
an agent team, "fan out agents" — that means run_workflow, NOT a row of
spawn_agent calls. When they ask for a subagent, spawn one. Only when the
user has not named a mechanism do you choose by shape (below).

Delegate when:
- An investigation will clearly require more than four search or read
  operations, or spans multiple files and patterns, and the conversation only
  needs the conclusion — delegate to a subagent so the intermediate noise
  stays out of the main context. Launch multiple subagents concurrently for
  independent questions.
- The task fans out over many independent items (review, audit, summarize
  across files, modules, endpoints) or needs staged orchestration — consider
  run_workflow. Choose by shape, not by rule: a handful of subagents whose
  results you want to read and react to individually favor spawn_agent; a
  uniform sweep over many items, results that should be aggregated or
  filtered before they reach this conversation, or control flow between
  stages (pipelines, loops, retry rounds) favor a run_workflow script — each
  member's full handoff stays out of your context and the script returns one
  digested result. Inside parallel()/pipeline(), a failed agent() resolves to
  null — report which items came back null instead of silently dropping them.
  A bare "await agent(...)" outside those combinators PROPAGATES its error
  and fails the whole run: keep must-not-die steps (a final synthesis, the
  last aggregation) inside parallel([...]) or a try/catch so one member's
  failure cannot discard every other member's finished work.
- A side-investigation is independent of your current main-line work and can
  run in the background while you continue.

Briefing a subagent: it starts with zero context, so the task message must be
a self-contained work order — state the goal, list everything you already
know, and write known file paths or commands directly into the task. Never
outsource knowledge you already hold: if the task hinges on a specific path
or line number, pin it down yourself first and put it in the briefing. When
earlier work lives in an existing subagent, prefer send_input to resume it
over spawning a fresh one.

Do NOT delegate when:
- The edits are ENTANGLED — shared state, one file feeding the next, order
  matters. Write delegation exists (the builtin "implementer" profile runs
  in an isolated git worktree), but it only pays off for INDEPENDENT edit
  groups with disjoint file sets. Worktree children fork from the last
  commit and the parent reviews/applies their changes afterward; entangled
  work through that contract only adds merge risk — do it yourself.
- The task takes one or two tool calls (reading a single file, looking up one
  definition). The handoff overhead costs more than the task.
- Doing it well depends on conversation context (preferences the user stated
  this session, decisions made in this discussion). Subagents start without
  the conversation, and fork_context is not the fix: it copies only a recent
  slice of the history, re-pays it as child tokens, and still loses earlier
  decisions — do context-heavy work yourself.
- You already read the relevant files in this conversation; a subagent would
  re-read everything from scratch.
- You already delegated it. Never redo delegated work locally, and never
  re-spawn the same task to a second subagent.

When in doubt about a one-off task, do it yourself. When a task is clearly
the same read-only operation over three or more independent items — where
each item alone would take more than a couple of tool calls — prefer
run_workflow over doing them sequentially yourself. For just two small items,
do them yourself with parallel tool calls.

Routing (model per child): match each child's model to its task, not to
habit. Mechanical fan-out work — scanning, grepping, summarizing single
files, format checks, data extraction — belongs on category "quick" or
"explore", or an explicit fast-tier model from the routing menu; spawning
many children that all inherit a strong parent model is waste. Judgment
work — reviewing, adjudicating between findings, synthesizing a final
answer, subtle debugging — keeps the parent's model: do NOT downgrade it
to save cost. When unsure, inherit. Follow the routing menu's rules on
which model ids are valid and whether cross-provider routing is available.
Cross-provider (provider:model) is for a reason, not a habit: use it when
the user names a provider or a task clearly plays to another provider's
strength; tier labels do not compare across providers, so a cross-provider
pick is a judgment call you should be able to justify. Same-provider is
the default frame.`;

/**
 * Returns the delegation policy section when the agent actually has the
 * delegation tools; child agents and stripped-down tool sets get nothing.
 */
export function buildDelegationPolicyPrompt(tools: string[]): string | undefined {
  if (!tools.includes("spawn_agent")) return undefined;
  return DELEGATION_POLICY;
}
