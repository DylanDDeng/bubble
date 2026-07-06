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

Delegate when:
- An investigation will clearly require more than four search or read
  operations, or spans multiple files and patterns, and the conversation only
  needs the conclusion — delegate to a subagent so the intermediate noise
  stays out of the main context. Launch multiple subagents concurrently for
  independent questions.
- The task naturally splits into the same read-only investigation or
  analysis (review, audit, summarize) over several independent items (files,
  modules, endpoints), or needs a staged pipeline over many subagents — use
  run_workflow with a simple script (a parallel() over the items is enough
  for the common case; failed agent() calls resolve to null, so report which
  items came back null instead of silently dropping them).
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
- The task requires editing files or running state-changing commands.
  Built-in subagents are read-only; do edits and writes yourself unless a
  write-capable (write_worktree) profile is explicitly available.
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
do them yourself with parallel tool calls.`;

/**
 * Returns the delegation policy section when the agent actually has the
 * delegation tools; child agents and stripped-down tool sets get nothing.
 */
export function buildDelegationPolicyPrompt(tools: string[]): string | undefined {
  if (!tools.includes("spawn_agent")) return undefined;
  return DELEGATION_POLICY;
}
