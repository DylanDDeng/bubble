# todo_write Removal — Harness Thinning, Wave 2

Status: **design final** (adversarial review by Kimi K3 incorporated 2026-08-14:
desktop/ consumer scope corrected, commit plan collapsed to one, Aegis claim
corrected, touchpoint list completed).

## Motivation

todo_write is a pure cognitive-governance mechanism: the harness teaches the
model a meta-skill it already has ("don't lose track of steps"), charges
~870 tokens of schema+description+guidance attention for it (measured:
description ~2,400 chars ≈ 600 tok + schema ~120 + compose.ts paragraph ~120
+ environment.ts entry ~25), and maintains a parallel state system (agent
field + version counter + event + session persistence + TUI panel + prompt
guidance in two places) to render that state back to the user. Current
strong models hold 10–20-step task state natively; longer horizons are the
goal system's job (budget + autonomy), not a checklist's.

Applied with the wave-1 ruler:

> Input is "the model's behaviour", output is a judgement/correction of that
> behaviour → delete. Supplies facts the model cannot see / guards authority
> / resource fuses → keep.

A self-managed checklist is squarely the first kind. **Full removal** — not
`deferred`, not hidden behind tool_search. Dead UI state must not linger in
the default tool surface.

No replacement is offered. If a model wants externalized progress tracking
it can write a PROGRESS.md and re-read it — the generic file primitives
already cover the honest version of this need.

## What goes

### The tool and its registration

- `src/tools/todo.ts` — delete file (`createTodoTool`, `TodoStore` interface).
- `src/tools/index.ts` — drop `createTodoTool` from `createAllTools` and the
  `todoStore` option from `CreateAllToolsOptions`.
- `src/main.ts:163–165, 217` — todoStore wiring.
- `src/sdk/index.ts:267–269` — same, plus SDK re-exports of `Todo` (:540).
- `src/feishu/agent-host/run-driver.ts:110–112, 116, 171, 188` — todoStore
  build, `todos: session.manager.getTodos()` restore, `onTodosUpdate` →
  `appendTodosSnapshot` hook.

### Agent state and events

- `src/agent.ts` — `_todos`, `_todosVersion`, `todosVersion` getter,
  `getTodos`/`setTodos` (:730–742), `clearTodosAfterInterruptedRun`
  (def :2223, call :1657), the all-complete auto-reset (:866–868), the
  mid-run version-diff re-emit (:1455, :1579–1580), `AgentOptions.todos` /
  `onTodosUpdate`, and the **second plan-mode read-only tool enumeration at
  :2256** (`"...skill, todo_write, tool_search..."` — separate copy from
  prompt/reminders.ts).
- `src/types.ts` — `Todo`, `TodoStatus`, the `todos_updated` AgentEvent
  variant.
- Emitter/consumer chain of `todos_updated`: `src/tui-ink/app.tsx:1780–1781`,
  `src/feishu/card/run-state.ts:118–119`, `src/debug-trace.ts:265–266`.

### Slash-command flows

- `src/slash-commands/commands.ts:565–567` — /clear's todos branch
  (`getTodos().length > 0 → setTodos([])`).
- `src/slash-commands/commands.ts:649` — /rewind's todos restore
  (`ctx.agent.setTodos(session.getTodos())`).

### Persistence

- `src/session-types.ts:93–95` — `SessionTodosSnapshotEntry`.
- `src/session-log.ts:85–103` — `appendTodosSnapshot` / `getTodos`;
  `"todos_snapshot"` leaves the entry-type whitelist (:283).
- `src/session.ts:219–227` — the two forwarding methods.
- `src/main.ts:381, 448, 477–478, 752, 764` — resume restore, persist hook,
  session-switch transfer.
- `src/sdk/index.ts:313, 327` — same for the SDK host path.
- `src/memory/phase1.ts:189–190` — todos_snapshot summarizer case (becomes
  unreachable: phase1 reads entries through the same load whitelist, so old
  snapshots never reach it — delete the case).

### Consumers

- `src/tui-ink/todos.tsx` — delete file (TodosPanel).
- `src/tui-ink/app.tsx` — todos state (:288), panel render (:2806–2808),
  clearMessages mirror (:824–827), adoptSession mirror `setTodos(agent
  .getTodos())` (:1013), todos_updated case (:1780), import.
- `src/tui-ink/message-list.tsx:1202` — `todo: "✓"` icon key (already dead
  code today: `toolGlyph` matches full tool names, key never matched).
- `src/prompt/compose.ts:120–121` — todo_write usage-guidance paragraph.
- `src/prompt/environment.ts:28, 46` — description + tool-name list entry.
- `src/prompt/reminders.ts:37` — "todo_write" in the plan-mode read-only
  tool enumeration.
- `src/agent/profiles.ts:76, 212, 222, 240` and
  `src/agent/subtask-policy.ts:20, 32, 44, 56` — allowedTools entries.
  Hygiene, not correctness: validation severity for unknown names is
  "warning" (profiles.ts:336–344; child-runner.ts:64–72 and
  subagent/runtime.ts:593–599 only block on "error"), so stale entries would
  only emit misleading warnings per spawn, not fail.

### The desktop/ package (same repo — the REAL breaking consumer)

`@bubblebrain-ai/bubble-desktop` (`file:..` dep) consumes root dist types
directly; the root tsconfig only includes `src/**`, so root tsc/vitest/build
staying green says NOTHING about it:

- `desktop/src/electron/agent-runner.ts:398, 497–499, 532, 610, 619` —
  todos restore, todoStore, `onTodosUpdate` → `appendTodosSnapshot`.
- `desktop/src/electron/turn-mapper.ts:127` — `todos_updated` → `plan_update`
  UI event mapping.
- `desktop/src/ui/components/TodoProgressCard.tsx` — the desktop progress UI.
- `desktop/_bubble-ref/bridge.ts:144–146, 184, 191`, `ipc-types.ts:33`.
- `desktop/scripts/verify-mapper.mjs:98–114` — asserts the
  todos_updated → plan_update mapping; goes red until patched.

Desktop must be patched in the same wave (it lives in this repo — one PR is
enough; no cross-repo coordination needed).

### Tests

- `src/__tests__/todo-tool.test.ts` — delete file.
- Surgical: `agent.test.ts` (:1833–1945 todos cases + mock options),
  `session.test.ts` (:226, :236, :447 snapshot round-trip),
  `slash-commands.test.ts` (:1145–1182 /clear + /rewind todo assertions),
  `rewind.test.ts` (:192–230 setTodos mocks).

## What stays, and why

- **The goal system** — resource fuse (token/turn budget), the "keep" side
  of the ruler. Long-horizon tracking remains its job.
- **Plan-mode's read-only fence** — authority guard, orthogonal to this wave.
- **`docs/harness-thinning.md` wave-1 deletions** — untouched.
- Session **log files on disk** — never rewritten; old `todos_snapshot`
  entries are simply skipped at load (below).

## Key decisions

1. **Old session logs.** Removing `todos_snapshot` from the whitelist makes
   `normalizeEntry` drop those entries at load (verified: readLog wraps
   per-line parse in try/catch and normalizeEntry returns [] for unknown
   types; `pruneIncompleteTail` only touches Message[]). They are UI state,
   not conversation data. Logs on disk stay byte-identical (append-only
   discipline holds). Revert-safe: old code's `getTodos` defaults to `[]`
   when no snapshot exists (session-log.ts:96–106).
2. **ONE commit, not two.** The reviewed two-commit plan had a compile-order
   break: commit 2's files (session-log.ts:6, session.ts:19,
   session-types.ts:1) import `Todo` types deleted in commit 1, while files
   listed under commit 2 (main.ts/sdk/feishu) call Agent APIs deleted in
   commit 1. Total diff is small; a single atomic commit avoids the trap.
   Desktop/ patches land in the same PR, after the root commit.
3. **Aegis (~/coworker) breakage ≈ zero** (corrected after review): Aegis
   calls no `getTodos` (grep = 0), re-declares `BubbleAgentEvent` locally
   with a catch-all variant (bubble-sdk-loader.ts:49–63), loads the SDK via
   dynamic import, and its `todos_updated` switch case is `default: return`
   (bubble-sdk-adapter.ts:900–903). Only dead label entries remain
   (tool-summary.ts:123,375,469) — cleanup optional, no urgency.
4. **No deprecation cycle for the tool itself.** Sessions mid-conversation
   lose nothing functional — worst case a model trained to reach for a
   checklist gets a "no such tool" and self-corrects to file-based tracking.
   /rewind and /clear paths simply lose their todos branch (no-op).

## Execution: one root commit + same-PR desktop patch

1. Root: delete everything in "What goes" (src/), with test surgery.
   `tsc --noEmit` + full `vitest run` green.
2. Desktop: patch agent-runner/turn-mapper/TodoProgressCard/_bubble-ref/
   verify-mapper; `npm run typecheck` + desktop verify scripts green.
   Baseline note: desktop typecheck is ALREADY red today on two unrelated
   errors (agent-runner.ts:420 missing `openPicker`, :475 `PlanDecision`
   shape — root API drift desktop never absorbed). The gate for this wave
   is "no NEW errors from todo removal"; fixing the pre-existing two is
   optional scope, decided at patch time.
3. Docs: this file's status flip + wave-ledger note that
   `docs/large-task-delegation-design.md:67–69,206` (planned
   `getTodos()`-based checkpoint nudge) is voided by this wave;
   `docs/architecture.html:546` tool-table row and
   `docs/subagent-design-sketch.md:136` reference updated.

## Verification checklist

- `npx tsc --noEmit` + full `npx vitest run` (root).
- **`cd desktop && npm run typecheck` + desktop verify scripts** — the check
  the previous design draft relied on without running.
- Repo-wide grep = 0 hits: `todo_write`, `TodosPanel`, `todos_updated`,
  `todos_snapshot`, `getTodos`, `setTodos`, `createTodoTool`, `TodoStore`
  (src/ and desktop/src/).
- `npm run build`.
- TUI smoke: fresh session, multi-step task, /clear, /rewind, session
  switch, plan-mode enter/exit — no todo references, no dead panel space.
- Resume an OLD session log containing todos_snapshot: loads clean, entries
  skipped silently, conversation intact.

## Risks

- **Model-habit regression**: some models reach for checklists; without the
  tool they fall back to prose or files. Accepted — that is the experiment
  this wave runs. If quality regresses on real workloads, revert is a clean
  `git revert` (no on-disk data was touched; revert-safety of new logs
  verified above).
- **Desktop loses its live progress card** (TodoProgressCard / plan_update):
  the desktop equivalent of the TUI panel loss below. Transcript remains the
  source of truth.
- **Lost TUI affordance**: users who liked watching live checklists lose the
  panel. The transcript itself (what the model actually did) remains the
  source of truth.

## Wave ledger (context)

Wave 1 removed the cognitive-governance layer (classifier/governor/barrier/
evidence/arbiter). Wave 2 (this) removes self-managed task state. Recorded
future candidates from the wave-1 doc remain: system-prompt thinning,
tool-intent fossils, subtask-policy dead fields, forceContinuationReason.
Voided by this wave: the getTodos-based large-task nudge sketched in
large-task-delegation-design.md.
