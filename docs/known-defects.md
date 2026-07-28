# Known Defects — found during the agent.ts extraction

Status: **mostly resolved** (2026-07-27, same day). Recorded while extracting
`SubagentRuntime` / `SubagentRouter` / `WorkflowLedger` out of `src/agent.ts`;
fixed in the commit series right after the extraction landed. Per-entry
status: 1 FIXED, 2 FIXED, 3 DECIDED (docs updated), 4 FIXED, 5 FIXED,
6 FIXED, 7 FIXED. All entries resolved as of 2026-07-28.

These were found during the refactor and deliberately **left out of it**: the
extraction commits are pure code movement, and folding a behaviour change into
a ~900-line move destroys the ability to bisect a regression back to either
the move or the fix. Each fix landed as its own commit afterwards; the
original analysis below is kept as written (line references describe the tree
BEFORE the fix commits).

Line references are against the post-refactor tree. Every claim here was
verified against source, not inferred.

---

## 1. [FIXED] Worktree leak when a `write_worktree` child exhausts scheduler retries

**Fixed**: `fix(agent): reclaim worktrees on scheduler-terminal outcomes` —
shared `reclaimWorktree` on all terminal paths, reuse guard rebuilds after
reclamation, kept-worktree state reset on resume.

**Severity: high** — leaks disk and `git worktree` registry entries, silently.

### What happens

`onFinal` is the only path that reclaims a child's worktree
(`src/agent/subagent/runtime.ts:143` → `finalizeSubagentWorktree`). It is
called from exactly four places, all inside `ChildRunner`
(`src/agent/child-runner.ts:73, 89, 210, 226`).

The scheduler's three terminal callbacks do **not** call it:

| Callback | Location | Calls `onFinal`? |
|---|---|---|
| `onCancelledWhileQueued` | `src/agent/subagent/runtime.ts:620` | no |
| `onRateLimitExhausted` | `src/agent/subagent/runtime.ts:631` | no |
| `onTransportRetryExhausted` | `src/agent/subagent/runtime.ts:642` | no |

All three only `persist` + `notifyWaiters` + `maybeEnqueueIngestion`.

The worktree is created during the first attempt, inside `createInstance` →
`createSubAgentInstance` (`src/agent/subagent/runtime.ts:763`) and reclaimed
only at `src/agent/subagent/runtime.ts:147`. A retryable failure returns
`{ kind: "rate_limited" }` / `{ kind: "transport_retry" }`
(`src/agent/child-runner.ts:174, 194`) **without** calling `onFinal`, so the
scheduler re-enters. When retries run out, the scheduler calls its terminal
callback — which also does not call `onFinal`. Nothing ever reclaims it.

### Repro

Spawn a child whose profile has `mode: write_worktree` against a provider that
returns 429 persistently. After `rateLimitMaxAttempts` (default 3), the child
ends `failed` / `rate_limited_exhausted` and its worktree directory plus its
`git worktree` registration remain on disk forever.

`onCancelledWhileQueued` is **NOT safe either** (corrected 2026-07-27 after
adversarial review): a 429/transport failure re-queues the entry and re-arms
the abort listener (`src/agent/subagent-scheduler.ts:318-323, 343-348`), so an
abort during backoff lands in `onCancelledWhileQueued` **after** attempt 1
already created the worktree and set `record.agent`. The comment at
`src/agent/subagent/runtime.ts:625` ("The run never started") is false for
this re-entry path — and it also means a `SubagentStart` hook fired with no
matching `SubagentStop` (hook pairing gap, see defect 5).

### Why not fixed here

Wiring the three callbacks to a shared finalize path is a real behaviour
change: it would newly emit `git worktree remove` and newly push a
`worktree: changes left in ...` line into `record.toolNotes`.

### No test would have caught it

`src/__tests__/subagent-worktree.test.ts` covers only the success paths
(created; removed when unchanged).

---

## 2. [FIXED] `setSessionID()` does not repoint the subagent persist directory

**Fixed**: `fix(agent): repoint the subagent persist dir when setSessionID
rebinds the session` — `SubagentStore.repoint` with eviction of final
non-workflow records; explicit config still wins.

**Severity: high** — cross-session subagent resume silently fails after a
session switch.

### What happens

`persistDir` is derived **once**, in the Agent constructor
(`src/agent.ts:335-338`), and handed to the runtime as a string
(`src/agent/subagent/runtime.ts:100, 123`), which immediately calls
`loadPersisted()`.

`setSessionID()` (`src/agent.ts:403`) only reassigns the field:

```ts
setSessionID(sessionID: string | undefined): void {
  this.sessionID = sessionID;
}
```

It does not rebuild or repoint the store. And the TUI reuses one `Agent`
instance across session switches — `src/tui-ink/app.tsx:1149` calls
`agent.setSessionID(...)` inside the switch path rather than constructing a new
`Agent`.

### Two consequences

1. Children spawned after switching to session B are persisted into **session
   A's** `.subagents/` directory. Reopening session B, `list_agents` cannot see
   them and `send_input` cannot resume them across processes.
2. `loadPersisted()` runs only at construction, so session B's own previously
   persisted children are **never** loaded into a switched-to session.

### Why not fixed here

Making `persistDir` live would change where files land on disk and could
suddenly surface a batch of previously invisible children — a behaviour change,
not a move. The refactor deliberately preserved the snapshot semantics (see the
comment at `src/agent.ts:333`).

Note for whoever fixes this: the store must stay **eagerly** constructed with
`loadPersisted()` at construction time. `list_agents` is expected to return
persisted children before any spawn happens in the process, and
`src/__tests__/subagent-persistence.test.ts` depends on it. Lazy-creating the
store on first spawn would break that.

### No test would have caught it

Nothing exercises `setSessionID()` followed by a spawn. This is precisely why
the defect went unnoticed. A characterization test pinning today's behaviour
would force the decision to be explicit when someone changes it.

---

## 3. [DECIDED] Subagent lifecycle hooks silently discard their result

**Decided: intentional, kept.** Discarding matches every terminal/lifecycle
event. `docs/hooks.md` now scopes `modelContext` to in-turn events, and the
runtime comment warns against "fixing" it.

**Severity: low / needs a decision** — may be intentional; the code does not say.

### What happens

`runSubagentLifecycleHookFor` (`src/agent/subagent/runtime.ts:678`) awaits
`parent.runExternalHook(...)` and throws the entire return value away. That
return value is `{ result: HookCombinedResult; events: AgentEvent[] }`, so both
the hook's events and its `modelContext` are dropped.

~~Every other `runExternalHook` call site in `Agent.run()` feeds the result
into `injectHookModelContext` (`src/agent.ts:460`). This one does not.~~
**Corrected 2026-07-27: that claim was wrong.** Discarding is the established
pattern for ALL terminal/lifecycle events — `Stop` (`src/agent.ts:1543`),
`StopFailure`, `SessionStart` / `SessionEnd` (`src/main.ts:516, 536`) all drop
`modelContext` too. Injection happens only for in-turn events
(UserPromptSubmit / PreModelCall / PreToolUse / PostToolUse / etc.). So this is
not an asymmetry in the code; it is an ambiguity in `docs/hooks.md`, which
never states which events honor `modelContext`. The fix belongs in the docs,
not the runtime.

The only comment present explains the `try/catch`:

```ts
} catch {
  // Subagent lifecycle hooks are observe-only; never fail the subagent.
}
```

"Observe-only" plausibly justifies dropping the result too — but it is written
as a justification for swallowing *exceptions*, not for discarding *output*.

### Why this matters for future refactors

This is a trap. The asymmetry looks exactly like an oversight, so the natural
instinct while touching this code is to "fix" it by injecting the hook's
`modelContext`. Doing so would push every child's `SubagentStart` /
`SubagentStop` hook output into the **parent's** transcript — a prompt change
affecting every turn.

### Action

Decide, then write the answer down. If intentional, extend the comment to say
the result is dropped on purpose and why. If not, injecting it is a real
feature change and needs its own review.

---

## 4. [FIXED] `grok-subscription-provider` test is not hermetic

**Fixed**: `fix(oauth): accept an injectable home dir in
importGrokCliCredentials so tests are hermetic`.

**Severity: medium (test infrastructure)** — fails or passes depending on the
developer's machine.

### What happens

`importGrokCliCredentials` tries two paths in order
(`src/oauth/grok.ts:269-272`):

```ts
const candidates = [
  join(bubbleHome, "runtimes", "grok", "grok-home", "auth.json"),
  join(homedir(), ".grok", "auth.json"),
];
```

The test `"returns undefined when no usable entry exists"`
(`src/__tests__/grok-subscription-provider.test.ts`) builds a `mkdtemp`
`bubbleHome` containing an auth file with no usable entry, and asserts the
result is `undefined`. Because the first candidate yields nothing, the function
falls through to the **real** `~/.grok/auth.json` on the developer's machine. If
that file holds a valid `https://auth.x.ai::` entry with both `key` and
`refresh_token`, the function returns real credentials and the assertion fails.

### Confirmed, not inferred

Observed live on 2026-07-27: the suite was green at 20:23; `~/.grok/auth.json`
was written at 20:35; every run afterwards failed this one test. Re-running the
same test against `git stash`-ed (pre-refactor) source reproduced the failure,
proving it is independent of the refactor.

### Fix direction

Isolate `homedir()` in the test, or give `importGrokCliCredentials` a way to
skip the home fallback. Do **not** simply delete the assertion — the fallback
itself is intended behaviour, only the test's exposure to it is wrong.

---

## 5. [FIXED] `markDelivered` bypasses the workflowInternal persistence gate

**Fixed** alongside defect 2: `store.persist()` refuses `workflowInternal`
records at the store level.

**Severity: medium** — found 2026-07-27 during adversarial review of the fix
plan for defect 2.

Workflow-internal members are supposed to never persist: `onFinal` gates on
`!record.workflowInternal` (`src/agent/subagent/runtime.ts:154`), and the
comment says "they never re-import into the store on restart". But
`store.markDelivered` persists unconditionally on reaching a final state
(`src/agent/subagent-store.ts:87-93`), and `executeWorkflow` calls it for every
completed member (`src/agent/subagent/runtime.ts:493`). Worse, the
`PersistedSubagent` schema has **no `workflowInternal` field** (grep: zero
occurrences in `subagent-store.ts`), so on the next `loadPersisted()` these
records come back as ordinary, resumable, `list_agents`-visible children.

Today this only shows on process restart. Fixing defect 2 (repoint +
loadPersisted on session switch) would raise the trigger frequency to every
session switch — so `persist()` needs a `workflowInternal` early-return
**before or together with** the defect-2 fix.

## 6. [FIXED] `SubagentStart` can fire without a matching `SubagentStop`

**Fixed**: `fix(agent): close the SubagentStart hook pair on backoff-cancel`
— pairing state (`hookStopPending`) tracked at the single choke point every
Start/Stop passes through; the cancel-while-queued path closes an open pair
and still skips Stop when no Start ever fired.

**Severity: low** — hook pairing gap, same root as the defect-1 correction.

Design §9 pairs hooks per started run. But when attempt 1 ran (Start fired),
the child got re-queued on 429/transport, and the abort arrives during
backoff, the terminal path is `onCancelledWhileQueued`
(`src/agent/subagent-scheduler.ts:160-168` via the re-armed listener), which
fires no `SubagentStop` (`src/agent/subagent/runtime.ts:620-630` — the "run
never started" assumption). External hook consumers see an unclosed pair.

## 7. [FIXED] `oauth/storage.ts` hard-codes the auth path at module load

**Fixed**: `fix(oauth): resolve the auth path at construction through
getBubbleHome` — construction-time resolution, injectable for tests, and
auth.json now honors BUBBLE_HOME / dev mode like every other config file.
Behaviour note: BUBBLE_DEV=1 sessions now keep credentials in
~/.bubble-dev/auth.json (previously shared production credentials).

**Severity: low (test infrastructure)** — same class as defect 4, harder form.
`AUTH_PATH = join(homedir(), ".bubble", "auth.json")` is a module-level
constant (`src/oauth/storage.ts:10`), frozen at import time — not even
parameter injection can isolate it. Report-only for now; any test that
exercises this module touches the real user auth file.

---

## Context: where these came from

Found during the `src/agent.ts` decomposition (3,473 → 2,531 lines):

- `src/agent/subagent/router.ts` — routing decision chain + §4 menu + §6 detector
- `src/agent/workflow/runs.ts` — background workflow run ledger
- `src/agent/subagent/runtime.ts` — thread lifecycle, dispatch, workflow execution

That work was verified as behaviour-preserving against an explicit invariant
list (unfiltered tool table; all five `drainToolUpdates` sites unmoved;
ingestion-before-delivery-before-input ordering; `record.worktree` assigned
before any throwing statement; `persistDir` as a snapshot; `void` vs `await`
hook call sites; no runtime-held `AbortController`; child-construction argument
set identical including the arguments that must stay absent). The four defects
above are the things that invariant list deliberately **froze in place** rather
than corrected.
