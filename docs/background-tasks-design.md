# Bubble Background Tasks & Scheduling — Design (v2, post-review)

Status: **implemented** (P0 + P1, 2026-07-18). Key code:
`src/tasks/manager.ts` (unified process manager, absorbed server-manager via
the `src/tools/server-manager.ts` re-export shim), `src/tasks/wake.ts`
(auto-resume gate/coalescer/orphan probe), `src/tasks/promotion.ts` (Ctrl+G
channel), `src/tools/bash.ts` (`run_in_background` + `promoted` terminal
kind), `src/tools/task-tools.ts` (deferred `task_output`/`kill_task`),
`src/agent/task-lifecycle-reminder.ts` + `Agent.consumeBackgroundTaskReminder`
(state-change gate) + `src/orchestrator/default-hooks.ts` (beforeTurn +
beforeContinuation injection), `src/loop/engine.ts` + app.tsx (`/loop`),
app.tsx (notices, kickTaskTurn wake via `internal: "task_wake"` payloads,
session-ownership markers, status row, inspector Tasks section).
Tests: task-manager (10), task-tools (9), task-lifecycle-reminder (6),
task-wake (7), task-promotion (3), loop-engine (6); full suite 1703 green,
server tests unchanged through the shim. Feishu/desktop enablement, `monitor`,
scheduler tools, and durable loops remain P2.

Motivated by the grok-build feature comparison (xai-org/grok-build user-guide
docs 20, 04): background commands with task ids, output polling/waiting/
killing, send-to-background, recurring prompts. Adapts those capabilities to
Bubble's existing substrate instead of porting the grok tool surface verbatim.

> **Revision 2026-07-19 — first field test, three fixes.** A real session
> (vitest in background + parallel doc work) exercised the full pipeline;
> timeline was correct end to end, with three findings fixed same-day:
> (1) the wake's unconditional "continue the work" nudge made the model
> invent follow-up work when nothing depended on the results — wording now
> says report-briefly-and-stop when nothing remains; (2) ANSI color codes
> from test runners leaked into model-facing output tails — stripped at the
> `taskOutputTail` choke point; (3) persisted wake/goal kick messages
> (internal-block-only user messages) rendered as raw user rows after
> --resume — `reconstructDisplayMessages` now hides them, fixing the
> pre-existing goal-kick variant too.
>
> **Revision 2026-07-18 (v2) — six-lens adversarial review, 32 confirmed
> findings folded in.** A 44-agent review workflow (6 lenses × per-finding
> skeptic verification against source) confirmed 32 of 38 findings. The big
> structural changes vs v1: host-capability gating (§2.0 — the tool is
> TUI-only in P0, print mode rejects it), the auto-resume wake moved OFF the
> user input queue onto a goal-engine-style internal kick (§2.3b), the task
> reminder trigger respecified as state-change-gated (§2.3a), Ctrl+G promotion
> given a real mechanism (`promoted` terminal kind + manager-owned buffers,
> §2.5), the merge discriminator renamed `kind` (`purpose` is a shipped
> model-facing server field, §2.2), three-layer process reaping (§2.2b), and
> session-switch ownership rules (§2.2c). Worktree/workflow children are
> denied backgrounding in v1 (§2.4).
>
> **Revision 2026-07-18 (v1) — three open questions resolved by user:**
> (1) auto-resume on task completion is **default ON**, with a config
> kill-switch and completion coalescing; (2) `task_output` + `kill_task` are
> both **deferred** — net active tool surface change is ZERO; (3)
> server-manager **merges into** the unified process manager now.

## 0. Motivation

Bubble's bash tool is strictly bounded and foreground: a long build, test
suite, or CI poll blocks the whole turn, and the only escape hatches today are
managed servers (`start_server` family — scoped to readiness-checked dev
servers) and background *subagents* (scoped to delegated model work). There is
no way to:

- start a one-shot long command and keep working (`cargo build`, `npm test`),
- check on it / block on it later,
- get told when it finishes,
- promote an already-running foreground command to the background,
- run a prompt on a recurring interval ("check the deploy every 5 minutes").

grok-build's answer is a task_id-unified family (`background: true`,
`get_command_or_subagent_output`, `wait_commands_or_subagents`,
`kill_command_or_subagent`, `monitor`, `/loop`, scheduler tools, Ctrl+G).
Their key lesson: **one task namespace and an explicit "never sleep-poll"
contract** teach the model a single mental model for all async work.

## 1. Existing substrate (build on, don't duplicate)

| Piece | Where | What it gives us |
|---|---|---|
| Bounded bash | `src/tools/bash.ts` | approval gate, sensitive-path block, process-tree kill (`killProcessTree`), output capping, abort wiring |
| Managed servers | `src/tools/server-manager.ts` | detached spawn + `unref`, 96KB log ring buffer, status lifecycle, stop-with-escalation |
| Subagent lifecycle | `wait_agent` / `close_agent` / `list_agents` (`src/tools/agent-lifecycle.ts`) | precedent for wait-with-timeout semantics and snapshot formatting |
| Per-call reminder | `src/agent/subagent-lifecycle-reminder.ts` + `src/orchestrator/default-hooks.ts` | the channel that makes the model aware of async state — NOTE (review): it is **activity-gated and append-only**, which shapes §2.3a |
| Goal auto-continuation | `src/goal/engine.ts` + `kickGoalTurn` in app.tsx | the pattern for harness-initiated turns — the auto-resume wake rides THIS, not the user queue (§2.3b) |
| GoalStore prop bridge | `src/main.ts` → `App` prop + onChange | the precedent for runtime state reaching the TUI (§2.6) |
| ui_notice rows | `display-history.ts` / `message-list.tsx` | accent-colored transcript notices for UI-level events |
| Deferred-tool unlock | `agent.unlockDeferredTools()` | programmatic unlock — the spawn path uses it so `task_output` needs no tool_search hop (§2.1) |

## 2. Design

### 2.0 Host capabilities (review: 3 blockers)

`run_in_background` is a **per-host capability**, threaded as an option
through `createAllTools` → `createBashTool`:

- **TUI (interactive)**: enabled. Full machinery: notices, auto-resume,
  status row, reaping.
- **Print mode (`-p`)**: **disabled**. The single-run process exits (and
  reaps) immediately after the turn — a background task would be killed right
  after the model was told it started. The bash tool returns a clear error:
  `run_in_background is unavailable in print mode; run the command in the
  foreground with an explicit timeout.`
- **Feishu / desktop hosts**: **disabled in P0** (they inherit tools via
  `createAllTools` and would otherwise get a tool with no completion story —
  tasks would finish silently and leak across chats). Enabling them is a P2
  item that requires each host to adapt the wake seam (§2.3b) explicitly.

The mid-turn reminder (§2.3a) is host-agnostic; everything in §2.3b/§2.5/§2.6
is TUI-scoped by construction.

### 2.1 Tool surface — net ZERO active tools

Respecting the 2026-07 tool-slimming direction (30 → 19), the model-facing
surface change is zero: one new parameter on `bash`, two deferred tools.

1. **`bash` gains `run_in_background: boolean`** (default false). No new spawn
   tool. When true:
   - the same approval gate runs first (§2.4);
   - the command spawns under the unified process manager (§2.2);
   - the spawn path calls `agent.unlockDeferredTools(["task_output",
     "kill_task"])` (review: the programmatic unlock API already exists —
     no tool_search hop, schemas are live the moment the first task exists);
   - the tool returns immediately:
     `Started background task task_0003 (<description>). It runs while you
     continue working; you will be notified when it finishes. Use task_output
     to check on it.`
   - the turn's `abortSignal` is deliberately NOT wired to the child — the
     task outlives the turn by design. Turn cancel kills foreground bash only.

2. **`task_output`** (new, **deferred**, auto-unlocked on first spawn).
   One tool covering grok's get + wait pair:
   ```
   task_output({ task_ids: string[], wait_ms?: number, mode?: "any" | "all" })
   ```
   - No `wait_ms`: non-blocking snapshot — status, elapsed, exit code if done,
     output tail (last N KB of the ring buffer).
   - With `wait_ms`: blocks until `mode` is satisfied ("any" default) or the
     deadline passes, then returns snapshots for all listed ids. Timeout is
     NOT an error — mirrors `wait_agent`'s "call again with a longer timeout"
     guidance.
   - Max 20 ids per call. Accepts `task_*` ids only (servers keep their
     dedicated tools; subagents use wait_agent; workflows use wait_workflow).
   - Description carries the anti-pattern contract verbatim: *"Never poll with
     foreground `sleep`; call task_output with wait_ms instead."*

3. **`kill_task`** (new, **deferred**, unlocked together with task_output).
   SIGTERM → SIGKILL escalation via the existing `killProcessTree`.

### 2.2 Runtime — unified process manager (`src/tasks/manager.ts`)

**Server-manager merges in now** (decision 2026-07-18). One registry owns
every child process Bubble manages.

**Discriminator is `kind: "task" | "server"`** (review: `purpose` is already
a shipped, model-facing server field with values `"preview" |
"verification"` — it appears in the start_server schema, drives the lifecycle
default, and is echoed in tool output/metadata; it stays server-only and
untouched). Server-only state (`purpose`, `lifecycle`, `port`, `url`,
`ownerRunId`, `lastUsedAt` touch-on-read) survives the merge unchanged; the
port-conflict scan and `stopAutoServersForSession` filter by
`kind === "server"`. The four shipped server tools keep their names, schemas,
and deferred status as thin wrappers; their tests move over and must stay
green unchanged.

Task record:

```ts
interface BackgroundTask {
  kind: "task";
  id: string;                    // task_0001 (ids never reused within a session)
  command: string;
  description?: string;          // model-provided, shown in UI + notices
  cwd: string;
  pid?: number;
  status: "running" | "completed" | "failed" | "killed";
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  output: string;                // ring buffer, 96KB cap like servers
  outputTruncated: boolean;
  ownerSessionId: string;        // REQUIRED — gates notices/wakes/reminders (§2.2c)
  deliveredAt?: number;          // wake or acknowledged reminder — drives pruning
}
```

**a. Instantiation and bridging** (review blocker: no data path was
specified). The manager is instantiated in `main.ts` — NOT a module
singleton — following the GoalStore precedent: passed to `createAllTools`
(bash + deferred task tools) and to `App` as a prop. It exposes
`onChange`/`onTaskFinished` subscriptions; the TUI subscribes for notices,
auto-resume, and the status row. Task children are spawned detached but
**NOT `unref`'d** (unlike servers): tasks must never outlive the parent, so
the event loop keeps them owned and a parent crash takes them down via the
process group where the OS allows.

**b. Reaping — three layers** (review blocker: `shutdownRuntime` never runs
on signal/crash exits):

1. graceful exit: a `shutdownTasks()` step in `shutdownRuntime`
   (SIGTERM → SIGKILL escalation, awaited);
2. signal path: task reaping added to the synchronous signal/exit handlers
   (`shutdownSidecars`-style), SIGKILL-only by necessity;
3. hard backstop: the manager's `process.once("exit")` handler SIGKILLs all
   `kind === "task"` children regardless of lifecycle (tasks never inherit
   the server `keep_alive` default).

Graceful reaping appends a `task_killed` marker per task so a clean exit
leaves no dangling `task_started` in the session file.

**c. Session ownership** (review: markers/notices/wakes landed in the wrong
session after `/session` switch — `applySessionSwitch` rebinds the manager
closure and clears the queued-input ref wholesale):

- At spawn, the task captures an **append callback bound to its owner
  SessionManager**, so `task_started`/`task_finished`/`task_killed` markers
  always land in the owner session's jsonl regardless of what is current.
  Markers encode `{ pid, startedAt }` as JSON so resume can probe liveness.
- ui_notice rows, auto-resume wakes, the lifecycle reminder, and the status
  row all filter on `task.ownerSessionId === <bound session>`. A completion
  for a non-current session emits nothing now; its wake fires if and when
  that session is switched back to (undelivered-completion sweep on session
  bind).
- On `/resume` in a fresh process, dangling `task_started` markers (no
  matching finished/killed) are probed by pid (+ startedAt guard against pid
  reuse where available): still-alive orphans are reported with an offer to
  kill; dead ones are reported once as orphaned.
- Session switch does NOT kill the outgoing session's tasks; they keep
  running with ownership intact.

**d. Caps and retention** (review: check-then-spawn race, unbounded finished
records):

- Concurrency cap: **8 running tasks per session**, enforced by an atomic
  reserve — count-check and placeholder insertion happen synchronously with
  no `await` between them (approval and validation run before the reserve;
  spawn failure rolls the placeholder back).
- Retention: at most 20 finished task records; oldest delivered evicted
  first; `output` dropped once a task is delivered (metadata line kept).

### 2.3 Completion notification — the crux

**a. Model-side: state-change-gated reminder** (review: the subagent
precedent is ACTIVITY-gated, not per-call, and the reminder channel is
append-only — "emit whenever tasks are live" would stack dozens of identical
persistent messages in a long turn; compaction preserves meta messages but
drops markers, so the reminder is also the id-recovery mechanism after
`/compact`).

`buildTaskLifecycleReminder(tasks)` is injected via the existing
before-turn/before-continuation hooks, but the trigger is **manager
state-change**: emit only when the owned task set changed since the last
emission (task started / finished / killed), queried through a
`ctx.agent`-level accessor (`agent.listBackgroundTasks()`, mirroring
`listSubAgents` in default-hooks). Completed-and-delivered tasks are demoted
to id+status one final time, then pruned (same "delivered" demotion the
subagent reminder uses). `deliveredAt` is set by a wake (§2.3b) or by the
model reading the task via `task_output` — a reminder display alone does not
count.

```
Background task truth:
- running: task_0003 (cargo build --release, 142s elapsed)
- finished since last update: task_0002 (npm test) exit 0 in 87s — output tail below;
  call task_output only if you need more.
- Never re-run work a finished task already did.
```

The reminder's stable phrases are added to
`INTERNAL_REASONING_REFERENCE_PATTERNS` (sanitizer) in the same change, per
the existing convention.

**b. Idle-side: transcript notice + auto-resume wake (default ON — decision
2026-07-18; channel respecified after review).** When an owned task finishes
while no turn is running:

- immediately append a `ui_notice` row: `✦ Background task task_0002 (npm
  test) completed — exit 0 in 87s.`;
- fire a **`kickTaskTurn`** modeled on `kickGoalTurn` — NOT a queued
  user-role input (review, 2 blockers: a synthetic user message is a prompt-
  injection channel and contradicts every existing harness-injected channel).
  The wake calls `runAgentInput` with the completion summary + a bounded,
  sanitized output tail wrapped in `formatInternalContextBlock("task-finished",
  ...)`, hidden from the visible transcript (the ui_notice row is the
  user-facing record). Guard rails:
  - **Coalescing as debounce-before-fire** (review: the idle queue drains in
    ~0ms, so a "merge while queued" window cannot exist): hold the wake for
    2s after the first completion; further completions within the window fold
    into the single wake payload.
  - **User preemption**: the wake fires only when no user-typed queued input
    is pending and no turn is running (exactly `shouldContinueGoal`'s
    `queuedInputs` check); user input always wins.
  - **Goal-loop compatibility**: because the wake is not a queued input, it
    no longer falsely trips the goal engine's `queuedInputs > 0` stop
    condition (review caught this interaction).
  - **Kill switch**: `tasks.auto_resume = false` in user config disables the
    wake (notice + reminder still happen). Killed tasks never wake (killing
    is an explicit decision, not news).

### 2.4 Approval, permissions, safety

- **`BashApprovalRequest` gains `background: boolean`** (review: without it,
  the "runs in background" line is unreachable — allow rules, the session
  allowlist, and bypass auto-approve without ever showing a dialog, and hooks
  cannot see the distinction). The interactive dialog renders the line;
  permission hooks receive the flag. Policy decision, documented: background
  requests ride the same fast paths (allow rules / allowlist / bypass) as
  foreground — consistent with the project's bypass philosophy — but the flag
  makes org-level hooks/rules able to discriminate.
- Sensitive-path blocking and deny rules short-circuit pre-spawn, same as
  foreground. Rights are evaluated at spawn; a later rule change does not
  retroactively kill a running task (documented).
- **Worktree/workflow children: `run_in_background` is denied in v1**
  (review: the v1 claim that `close_agent` reaps child tasks was
  unimplementable — children run with `sessionID: undefined`, the record had
  no per-child owner key, and `finalizeSubagentWorktree` would delete a
  running task's cwd). Children gain nothing from backgrounding (they cannot
  receive wakes); the child bash tool rejects the flag with a clear error.
  If a future need appears: add `ownerAgentId` (the child's `subAgentId`),
  reap via `taskManager.reapOwnedBy(agentId)` before worktree finalize —
  sketched, not built.

### 2.5 TUI

- **Status row**: the below-composer row takes a second data source — a
  tasks snapshot from the manager subscription held in App state (review:
  this is not an "extension" of the subagent row; different store). Render
  condition becomes `subagentMembers.length > 0 || runningTasks.length > 0`;
  label `↳ 2 subagents · 1 task · cargo build 142s`. The `nowTick` elapsed
  counter must also run while `runningTasks.length > 0` even when no turn is
  running (review: it currently ticks only while `isRunning`). The subagent
  inspector gains a "Tasks" section (id, description, elapsed, exit code,
  kill binding `x`).
- **Ctrl+G — send to background** (P1; mechanics respecified after review —
  4 findings converged on the same two defects: `finish()` destroys the
  child's stdio streams, and bash's head-capped 50KB buffer is not the
  manager's 96KB tail ring):
  - From spawn on, background-*capable* bash calls register their child with
    the manager, and the **manager's ring buffer is the single source of
    truth** for output — the foreground result view reads from it, so
    promotion is a flag flip, not a buffer handoff.
  - A new `promoted` terminal kind in bash.ts resolves the tool call by:
    clearing `timeoutHandle`/`forceKillHandle` and the abort listener
    (so the foreground timeout cannot fire post-promotion), **skipping**
    `cleanupBackgroundGroup` and `destroyStreams`, and returning
    `[Moved to background: task_0004. Output so far:]\n<tail>`.
  - Promotion is a no-op ("too late — command already finished") if a
    terminal kind is already set (race with exit/timeout/abort).
  - Key binding must respect the non-colliding-channels rule (project
    memory); verify against input-box.tsx before choosing Ctrl+G.
- **Synthetic-origin rendering** (review): auto-resume wakes are hidden
  internal context (the ui_notice is their visible record); `/loop` firings
  render with a distinct origin badge (`⟳ loop`) rather than as ordinary
  user rows — an `origin` flag on the submit payload drives both.
- Session markers are for tooling/audit and resume-time orphan probing; they
  are NOT rendered as transcript rows on resume in P0 (review: marker
  reconstruction does not exist today; mapping markers to ui_notice rows on
  resume is optional P2 work).

### 2.6 `/loop` — recurring prompts (P1)

TUI-level, model-free scheduling (sibling of the goal engine, NOT a model
tool):

- `/loop 5m <prompt>` — parse interval (`Ns` min 60s, `Nm`, `Nh`), fire
  immediately, then re-fire when idle; a running turn defers the firing (it
  does not stack).
- Firings submit with `origin: "loop"` (badge rendering, §2.5) and do not
  count as user input for the goal engine's stop condition.
- `/loop list` / `/loop stop [n]`; session-scoped, die with the process;
  max 5 active loops; a skipped firing (previous still running) emits a
  ui_notice.
- Pure decision module `src/loop/engine.ts` with unit tests, mirroring
  `goal/engine.ts`.

## 3. Phasing

- **P0 — core loop**: unified process manager (server-manager absorbed,
  `kind` discriminator, wrappers keep the four server tools intact, tests
  moved) + host-capability gating (§2.0) + `run_in_background` on bash +
  deferred `task_output`/`kill_task` with programmatic unlock + state-change
  reminder + ui_notice rows + `kickTaskTurn` auto-resume (debounce
  coalescing, config kill-switch) + three-layer reaping + session-ownership
  rules + atomic concurrency reserve + retention. Tests: manager unit tests
  (spawn/finish/kill/cap-race/ring buffer/retention, server parity), tool
  tests (wait modes, timeout-not-error, print-mode rejection, child denial),
  reminder builder tests (state-change gating, delivered demotion), wake
  tests (debounce, preemption, session filter, goal-loop non-interference).
- **P1 — UX**: Ctrl+G promotion (`promoted` terminal kind), inspector Tasks
  section, status row + idle tick, `/loop`.
- **P2 — later**: feishu/desktop enablement (per-host wake seams), `monitor`
  tool, model-facing scheduler tools, durable tasks/loops, marker→notice
  resume rendering, id-namespace consolidation (§5).

## 4. Resolved decisions

1. **Auto-resume: default ON** — via `kickTaskTurn` internal channel, NOT the
   user queue (revised by review); debounce coalescing; `tasks.auto_resume`
   kill switch.
2. **`task_output`/`kill_task`: deferred** — with programmatic
   `unlockDeferredTools` at first spawn (revised by review: no tool_search
   hop after all).
3. **Server-manager: merged now** — under a `kind` discriminator (revised by
   review: `purpose` was taken).
4. **Hosts: TUI-only in P0** (added by review) — print mode rejects the flag;
   feishu/desktop wait for explicit wake seams.
5. **Children: denied in v1** (added by review) — worktree/workflow subagents
   cannot background.

## 5. Deferred sketch — unified wait (v2)

One `wait` tool accepting `task_*` / agent ids / `run_*`, dispatching by
prefix, returning uniformly-shaped snapshots; `wait_agent`, `wait_workflow`,
`task_output`'s blocking mode collapse into it and are removed from the
prompt. Do this only once all three families are stable and the delegation
prompt is being revised anyway — tool renames are prompt-behavior changes
(lesson from the 2026-07-06 agent_team/agent_batch removal).
