# Large-Implementation-Task Delegation Nudge — Design (v2, post-review)

> **Superseded in part (2026-08-14):** the §checkpoint nudge design at :67–69
> and :206 reads `ctx.agent.getTodos()` — that API was removed with the
> todo_write system (harness-thinning wave 2; see
> todo-write-removal-design.md). Those passages are void; the detector itself
> remains historical context only (the wave-1 governance layer removed it).

Status: **implemented** (2026-07-19). Key code: detector + checkpoint in
`src/orchestrator/default-hooks.ts` (`maybeQueueLargeTaskNudge`, read-only
evidence accumulation in afterToolCall, `delegation_detector` traceEvent),
state fields in `src/orchestrator/hooks.ts`, reminder in
`src/prompt/task-reminders.ts` (`largeImplementationTaskReminder`) +
sanitizer patterns, Agent accessors (`activeSubAgentCount`,
`hasRunningWorkflow`, `largeTaskNudgeConsumed` session latch) and steer
reset in `src/agent.ts`, builtin `implementer` write_worktree profile +
`hasWriteWorktreeProfile` in `src/agent/profiles.ts`, delegation-prompt
entangled-edits clause in `src/prompt/delegation.ts`. Tests:
`large-task-nudge.test.ts` (10 cases: thresholds, todo corroboration, every
gate, once-per-turn, wording, profile); full suite 1717 green. Field
tuning pending via BUBBLE_TRACE `delegation_detector` events.

> **Revision 2026-07-19 (v2) — four-lens adversarial review, 26 confirmed
> findings folded in (1 refuted).** Structural changes vs v1: breadth
> evidence is READ-only (search match paths destroyed the threshold, §1);
> the taskType gate is inverted (broad requests classify as
> general/debugging, never "implementation", §2); the reminder's
> recommended spawn surface must actually exist — this design now ships a
> builtin write_worktree profile and fixes the delegation prompt's
> opposing pressure (§3); the already-delegating gate uses ACTIVE children
> + running workflows (listSubAgents is a grows-only session history, §2);
> the nudge is once per SESSION (goal loops re-arm per-turn latches, §2);
> todo evidence comes from the agent's persistent list, demoted to a
> corroborating signal (§1); the reminder carries the real worktree
> mechanics — children fork from the last commit, disjoint file sets,
> compose-don't-contradict clauses (§3); detector decisions are traced for
> threshold tuning (§5).

Closes the deliberate gap left by the orchestration v2 revisions: the
delegation nudge (`DELEGATION_NUDGE`, `src/prompt/task-reminders.ts:17`) is
gated to exploration-shaped tasks, so large *implementation* tasks delegate
only when the model's own prior says so. Goal: make "this change is broad →
split it across write subagents" fire reliably, without re-opening
over-delegation.

## 0. Constraints inherited from orchestration v2 (2026-07-06 lessons)

1. **Wording loses to model priors** — harness detector + decision-point
   reminder is the mechanism, same as the existing nudges in
   `default-hooks.ts` beforeTurn.
2. **No hard forcing.** The harness raises probability; the model keeps
   the judgment.
3. **Anti-amplification gates are load-bearing** — v1's own review proved
   how easily they silently break (§1).

## 1. The detector — evidence, not text guesses

Breadth becomes observable during the turn. Evidence (accumulated in
`TurnHookState` via `afterToolCall`):

- **`exploredFiles: Set<string>` — files actually READ, nothing else.**
  Source: `!result.isError` results with `metadata.kind === "read"`,
  taking `metadata.path` resolved against `ctx.cwd` (bash-parsed reads —
  `cat`/`head`/`sed -n` — carry relative paths; the read tool absolute
  ones; both count after resolution). **Search results contribute
  nothing**: glob/grep return up to 100 match paths per call
  (`glob.ts:118`, `grep.ts:121` — and `metadata.path` there is the search
  ROOT, not a file), so counting matches lets one routine search saturate
  any threshold — the exact amplification the gates must prevent (review:
  3 lenses converged on this). A search proves the repo is big, not that
  the task is broad; a read is the model spending context on a file.
- **`plannedTodoCount` — corroborating signal only, from the persistent
  list.** Read `ctx.agent.getTodos()` at the checkpoint and count
  `pending`/`in_progress` items (NOT `todo_write` call args: the tool is
  named `todo_write`, its result carries no metadata, and counting
  completed items from lists that persist across runs misfires on
  nearly-done continuations). A big plan does not independently trigger —
  it lowers the file threshold (todo items measure sequential steps, not
  parallelizable breadth).

Trigger, checked in `beforeToolCall` on the first `edit`/`write` of the
turn (`isMutationTool`, `default-hooks.ts:237`):

```
!state.largeTaskNudgeSent                              // once per turn
  && !ctx.agent.largeTaskNudgeConsumed                 // once per SESSION (§2)
  && taskType !== "code_review"
  && taskType !== "security_investigation"             // inverted gate (§2)
  && ctx.agent.hasToolAvailable("spawn_agent")         // parent only
  && ctx.agent.activeSubAgentCount() === 0             // ACTIVE children only (§2)
  && !ctx.agent.hasRunningWorkflow()                   // run_workflow counts as delegating
  && writeWorktreeProfileAvailable                     // the recommended surface exists (§3)
  && (state.exploredFiles.size >= (todoCorroborates ? 5 : 8))
```

where `todoCorroborates = pendingTodos >= 6`. The reminder is queued via
`ctx.queueReminder` — it flushes before the NEXT model call, i.e. after
the current tool batch. The design claim is therefore "**at most one tool
batch of edits** lands before the pivot", not "one small edit" (models
batch parallel edits); the reminder handles that reality in its wording
(§3).

**Steer reset**: when a mid-run steer is applied, `exploredFiles` is
cleared and `taskType` re-classified from the steer text — pre-steer
evidence must not fire a nudge about a task the user just redirected.

## 2. Gate corrections (all review-driven)

- **taskType gate inverted.** The review re-ran the actual classifier
  (`task-classifier.ts`): broad refactor requests ("把所有工具的 metadata
  补全", "refactor the routing layer") classify as `general` or
  `debugging`, essentially never `implementation` — v1's
  `=== "implementation"` gate excluded the design's own target set,
  including its own §5 validation case. The first mutation call is itself
  the proof of an implementation turn; the classifier only EXCLUDES
  clearly-wrong shapes (`code_review`, `security_investigation`).
  `debugging` stays eligible deliberately: misclassified broad
  implementations land there, and the reminder's entanglement clause is
  the guard.
- **Active-delegation gate.** `listSubAgents()` is a grows-only session
  history (`subagent-store.ts:53-68` never deletes; `loadPersisted`
  restores finished children on resume) — v1's `length === 0` meant "never
  delegated in this session's lifetime", permanently disabling the nudge
  after any child, while missing run_workflow delegation entirely
  (workflow children are `workflowInternal` and filtered out). Fix: expose
  the store's existing `active()` filter
  (`isFinalSubagentThreadStatus`, already used at `agent.ts:2838`) as
  `activeSubAgentCount()`, plus `hasRunningWorkflow()` over
  `listWorkflows()`.
- **Once per session.** Goal-loop continuations create a fresh
  `TurnHookState` every turn and re-accumulate evidence — a per-turn latch
  nags on every goal turn. Precedent: the routing reminder's
  once-per-session consume (`consumePendingRoutingReminder`,
  `default-hooks.ts:201`). If the model read the nudge once and chose not
  to delegate, repeating it is exactly the nagging the small-task hint
  removal was about.

## 3. The reminder — and making its recommendation real

**Blocker from review: the recommended surface does not exist in a stock
session.** Builtin agent profiles are all readonly; `write_worktree` is
reachable only via user-authored profile frontmatter — and the delegation
section of the system prompt (`delegation.ts:54-57`) actively steers
toward readonly exploration children. A reminder recommending an
unavailable mechanism would burn trust in the whole channel. This design
therefore includes:

1. **A builtin `implementer` profile** (`mode: write_worktree`, tools:
   read/glob/grep/edit/write/bash) shipped alongside the nudge, so
   `spawn_agent` can honor the recommendation everywhere.
2. **A delegation-prompt touch-up**: the write-children sentence stops
   implying "readonly only"; one line documents the worktree fork/apply
   contract.
3. The trigger's `writeWorktreeProfileAvailable` gate stays anyway
   (defense in depth for hosts that strip profiles).

Reminder text (final wording lives in `task-reminders.ts`; stable phrases
join the sanitizer patterns):

```
Large-change checkpoint: you have read <N> files this turn (plan:
<M> open todo items) and are starting to edit; <K> edits from your current
batch will land regardless.
- If the REMAINING edits form INDEPENDENT groups (per-module, per-file,
  same shape repeated), split them across write_worktree subagents
  (spawn_agent with the implementer profile) or one run_workflow script.
  Assign each child a DISJOINT file set; keep shared files (types,
  registries, exports) for yourself. Children fork from the last COMMIT —
  commit your applied edits first, or fold them into the child briefings.
  Each child still makes the smallest coherent edit for its group.
- If the edits are ENTANGLED (shared state, one file feeding the next,
  order matters), delegation only adds merge risk — proceed yourself.
- Work already small enough to finish directly: just finish it.
```

Composition rules (review: same-turn contradictions):

- When `orchestrationRequestReminder` fired this turn, the nudge drops the
  `spawn_agent` branch and names only `run_workflow` (the user named the
  mechanism; do not offer the path that reminder just forbade).
- The "smallest coherent edit" clause is lifted verbatim from the
  implementation-workflow reminder so the two compose instead of
  fighting.
- `<K>` (mutations already applied this turn, via the `isCodeWriteResult`
  check) makes the batch reality explicit instead of pretending the pivot
  is free.

## 4. Explicitly out of scope (v1)

- **Bash/patch-driven mutations as the checkpoint trigger** — a turn whose
  first mutation is a bash `sed -i` or a patch tool call bypasses the
  nudge; documented accepted miss (bash READ intent does feed
  `exploredFiles`).
- **Plan-mode exit as a second injection point** — measure the
  mutation-point nudge first.
- **Mid-implementation re-detection**, **hard forcing**, **config
  thresholds** — unchanged from v1.
- **Delegated-exploration breadth** (a readonly child read 40 files; the
  parent read 3) — the parent's own reads undercount true breadth here;
  revisit once field data shows it matters.

## 5. Implementation sketch

- `src/prompt/task-reminders.ts`: `largeImplementationTaskReminder(...)`
  + sanitizer patterns.
- `src/orchestrator/hooks.ts`: `exploredFiles`, `largeTaskNudgeSent`,
  `steerApplied` on `TurnHookState`.
- `src/orchestrator/default-hooks.ts`: read-result accumulation in
  `afterToolCall` (kind === "read", `!isError`, cwd-resolved); checkpoint
  in `beforeToolCall`; steer reset.
- `src/agent.ts`: `activeSubAgentCount()`, `hasRunningWorkflow()`,
  `largeTaskNudgeConsumed` latch, todo count via existing `getTodos()`.
- `src/agent/profiles.ts` (+ builtin registry): `implementer`
  write_worktree profile; `delegation.ts` prompt touch-up.
- **Telemetry for tuning** (review: the promised field logs had no
  emitter): `traceEvent("delegation_detector", { fired, exploredFiles,
  pendingTodos, taskType, suppressedBy })` at every checkpoint evaluation
  — including near-misses and suppressions. BUBBLE_TRACE-gated is
  acceptable for the first tuning week (self-use); revisit if broader
  data is needed.
- Tests: evidence accumulation (read-only, bash-read resolution, search
  exclusion), threshold boundaries with/without todo corroboration, every
  gate in §1-2 (active children, running workflow, once-per-session, steer
  reset, profile availability), composition rules, wording snapshot.
- Field validation: one known-broad task (nudge fires, once) and one
  narrow task with a leading `glob src/**/*.ts` (nudge must NOT fire — the
  v1 regression case).

## 6. Open questions

1. Thresholds 8 files (5 with todo corroboration) / 6 todos — opening
   bids; tune from `delegation_detector` traces.
2. Should the builtin `implementer` profile also be advertised in the
   delegation system prompt, or stay reminder-only until field data shows
   models use it well?
