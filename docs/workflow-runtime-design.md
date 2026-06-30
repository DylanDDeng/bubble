# Bubble Orchestration — Design (v2: adaptive in-loop fan-out)

Status: **implemented** (all 4 phases, 2026-06-29; supersedes the v1
"arbitrary-JS workflow runtime / option C" draft, preserved as a deferred option
in the appendix). Builds on the implemented subagent runtime
(`subagent-runtime-design.md`, all 5 phases shipped 2026-06-12). Key code:
`src/agent.ts` (`resolveRouteForSubagent` override §1.1, `runAgentBatch` §1.3,
schema validation+retry in batch §1.2, `isolateReadonlyChildFileTools` call §2),
`src/tools/agent-lifecycle.ts` (`model`/`effort` on spawn_agent & agent_team,
`createAgentBatchTool`), `src/agent/structured-output.ts` (validator + helpers),
`src/tools/child-tools.ts` + `src/tools/read.ts` (`cloneForChild` isolation),
`src/agent/categories.ts` (`parseThinkingLevel`). Tests:
`src/__tests__/orchestration-v2.test.ts` (11 cases). Full suite green
(1306 passing), typecheck + build clean.

## 0. The pivot — what "flexible like Claude Code" actually means

The original goal was "dynamic workflows like Claude Code." A four-lens
first-principles review (2026-06-29) established that this goal was **mis-aimed**:

- Claude Code's *perceived* flexibility comes from its **agentic loop** — the
  model delegates, sees each result, and **re-plans against it adaptively**
  ("this result is odd, investigate differently"). The orchestrator is *in the
  loop, interpreting*.
- A model-authored **workflow script** (option C) does the opposite: the model
  pre-commits to a script *before any agent has run*, then is removed from the
  loop while it executes. A pre-written script can only branch on contingencies
  its author anticipated. **C is therefore *less* adaptive than the thing it
  claimed to imitate.**

So the real target is **not** a script engine. It is to make Bubble's *own*
agentic loop as expressive an orchestrator as Claude Code's — keeping the model
in the loop, where flexibility actually lives.

**Bubble's loop is already an adaptive orchestrator:** `spawn_agent` is
non-blocking and children run concurrently through the scheduler
(`agent.ts:1686/1692`); `wait_agent` collects results; `send_input` redirects a
running child; and children return only a **summary** to the parent — their full
transcript stays in the child thread, so intermediate detail never pollutes the
parent's context (the very property the script approach worked hard to
simulate). The loop is missing only three concrete primitives.

## 1. The three missing primitives

### 1.1 Per-call model / effort (the load-bearing one — and the original complaint)
Today a child's model comes only from a pre-configured `category` or the
profile's `model` field; it cannot be named at call time. We extend
`resolveRouteForSubagent` (`agent.ts:2033`) to take an explicit override.
Priority becomes:

```
call-site model/effort   >   profile.model   >   category.model   >   inherit parent
```

- `model` flows through the existing `resolveModelRoute` / `parseModelSelection`
  (`categories.ts:116/134`), so `provider:model` cross-provider syntax works.
- `effort` maps to `thinkingLevel`, validated against `THINKING_LEVELS`
  (`categories.ts:31`) before it can reach the provider.

Added as optional params on `spawn_agent` and `agent_team`, and per-spec inside
`agent_batch` (§1.3). This alone lets the model do "opus for this reviewer,
haiku for these twenty scouts."

### 1.2 Structured output (`output_schema`)
So the model can **reliably branch on a child's result** rather than re-parsing
prose. When a spec carries `output_schema` (a JSON Schema), the child gets a
synthetic `StructuredOutput` tool injected with `tool_choice` forced to it; the
result is validated with **`@cfworker/json-schema`** (no `eval`, Bun-safe — the
project has no schema validator today) and the child is re-prompted on mismatch
(bounded retries) inside its own thread. The parent receives the validated
object (rendered as fenced JSON, treated as untrusted data per the existing
`sanitizeSubagentSummary` / fencing path). This is what turns a fan-out into a
typed dataflow the model can compute on.

### 1.3 `agent_batch` — heterogeneous fan-out as a *single* tool call
`agent_team` only fans out **one template over N items** (homogeneous). The
model often wants N **different** tasks, each with its own model. `agent_batch`
provides that:

```jsonc
{
  "description": "scout modules",                 // 3-5 words, UI label
  "specs": [                                      // 2..N heterogeneous children
    { "task": "Audit src/auth for missing checks", "agent_type": "explorer",
      "model": "anthropic:claude-opus-4.1", "effort": "high", "output_schema": {…} },
    { "task": "List all callers of parseToken",    "model": "haiku", "effort": "low" }
  ]
}
```

Semantics mirror the hardened `agent_team`: each spec → one child through the
**same** scheduler admission/dispatch, the tool **blocks in the foreground**
until every child reaches a final state, results return in spec order, failed
members are individually resumable via `send_input`.

**Why a single tool call, not "let the model emit N parallel `spawn_agent`
calls" (the rejected option A):** Bubble's git history records the exact failure
mode of model-emitted parallel tool_calls — `68efa2d "Fix Kimi 400 from parallel
tool_calls losing responses"` and `abb7914 "disable parallel tool calls for
fireworks kimi"`: some providers 400 or lose/misalign responses when one
assistant message carries multiple tool_calls, which surfaces to the model as
*wrong or missing results* and costs it a recovery turn. `agent_batch` keeps the
model emitting **one** tool_call; the parallelism happens **inside the runtime**
(the scheduler dispatches N children). The provider's parallel-tool_call path is
never exercised, so that class of bug cannot recur. Like `agent_team`,
`agent_batch` must be the **only** tool call in its response (`agent.ts:1071`
enforces the analogous rule for `agent_team`).

## 2. Correctness: per-child tool isolation

Children currently share the **parent's** tool instances (readonly children
share read tools, hence a shared `FileStateTracker`, `read.ts:24`; design §8
only gives *write* children fresh instances). Concurrent children then write
into one shared `FileStateTracker`'s maps. Reads are path-keyed → no child ever
reads the wrong *content*, but the shared version/history tracking is a latent
race. Fix: `createChildTools(cwd)` builds a fresh read/edit/write/bash set with
its **own** `FileStateTracker` per child (extend the §8 write-child factory to
**all** children). Each child already runs its tools **sequentially** within its
own loop, so with per-child instances there is no shared mutable tool state
across the concurrent fan-out at all.

## 3. What stays the same — and why the C-review's hard problems vanish

Because orchestration stays **in the model's loop** and fan-out is **foreground
and blocking** (like `agent_team`), the entire class of defects the v1/C review
surfaced **does not arise**:

- No JS sandbox → no QuickJS engine, no asyncify-serializes-`parallel()` FATAL,
  no host-throw-corrupts-VM FATAL, no determinism gating, no escape surface.
- No background script outliving a turn → no out-of-loop event pump, no idle-VM
  pumping question, no next-turn-cancellation gap, no `claude -p` delivery loss.
- No per-run budget envelope over a shared ledger → reuse `computeChildTokenCap`
  and the existing `agent_team` pre-check (`agent.ts:1816`) as-is.
- No resume/journal, no determinism tax → cut entirely.

Reused verbatim: `SubagentScheduler` (single dispatch, 429/AIMD, transport
retry, launch throttle), `SubagentStore`, `BudgetLedger`, `ChildRunner`,
worktree write isolation, the lifecycle reply protocol, the `directEmit` TUI
wiring (`agent_batch` reuses `agent_team`'s `ctx.emitUpdate` path, design §1.2).

The one genuine cost of staying in-loop is **parent context growth** across many
delegated turns — mitigated by what already exists (children return summaries,
not transcripts) plus structured output (compact typed results). If a workload
ever genuinely needs hundreds of agents whose coordination would blow the
parent's context, that — and only that — is when the deferred script runtime
(appendix) earns reconsideration.

## 4. The adaptive loop in practice

What the model can now do, all in-loop and adaptive:

1. `agent_batch`: 20 scouts on `haiku`/`low`, each with an `output_schema`.
2. Read the 20 typed results (summaries off-context, structured data in-context).
3. **Decide based on what came back** — module 7 looks anomalous.
4. `spawn_agent` an `opus`/`high` deep-dive on module 7, or another `agent_batch`.
5. Synthesize.

Step 3 is the flexibility C could not provide: the model branches on *actual
results*, not on contingencies pre-baked into a script.

## 5. Security & invariants (unchanged from the subagent runtime)
- Children readonly by default; no spawn/batch parameter upgrades a profile's
  mode (`isolation:"worktree"` → existing `write_worktree`, runtime-allocated
  path). Per-call `model`/`effort` change *routing only*, never capability.
- Children never see lifecycle tools (`SUBAGENT_DENY_TOOLS`); `agent_batch`
  joins that deny set (anti-recursion).
- Child output and `output_schema` results are untrusted data, fenced.
- Concurrency, budget, rate-limit, retry remain runtime-owned; no tool parameter
  sets them.

## 6. Phases & acceptance

| Phase | Scope | Acceptance |
|---|---|---|
| **1** | Per-call `model`/`effort` override on `spawn_agent` + `agent_team` (§1.1) | a child runs on a call-named model/effort; override beats category and profile; invalid effort rejected before the provider; `provider:model` cross-provider works |
| **2** | `agent_batch` (§1.3): single-tool-call heterogeneous fan-out, scheduler dispatch, foreground block, spec-order results, sole-call rule | N heterogeneous children run concurrently from **one** tool_call; no provider parallel-tool_call path exercised; TUI shows live member updates; failed member resumable via `send_input`; budget pre-check parity with `agent_team` |
| **3** | `output_schema` (§1.2): forced `StructuredOutput` tool + `@cfworker/json-schema` validation + bounded retry | schema mismatch retries then surfaces; parent receives validated object; an `agent_batch` fan-in consumes typed results |
| **4** | Per-child tool isolation (§2): `createChildTools` for **all** children, own `FileStateTracker` | concurrent children share no mutable tool state; a saturated `agent_batch` of read/edit children shows no cross-talk |

Each phase ships the existing three test classes (unit / fake-provider
integration / TUI snapshot). No new sandbox/determinism test surface.

## 7. Explicitly deferred
The arbitrary-JS workflow runtime (option C — QuickJS sandbox, `parallel`/
`pipeline`/`phase` script API, determinism, resume, background execution,
`/workflows` view). Reconsider **only** on evidence that a real workload needs
unattended, hundreds-of-agents fan-out whose coordination the in-loop loop
cannot pace. See appendix for the must-knows if it is ever revived.

## Appendix A: deferred option C — must-knows if revived
The v1 design and a four-lens review proved, empirically (Bun 1.3.5 / Node 22):
- **Sandbox = QuickJS-wasm only.** `node:vm` escapes its realm on Bun too
  (`this.constructor.constructor("return process")()` → real host process);
  `isolated-vm` won't load under Bun (JSC ≠ V8). QuickJS holds (no host realm,
  `setInterruptHandler`/`setMemoryLimit` work).
- **Engine bridge must be `newPromise` deferred-promise on the SYNC variant, not
  `newAsyncifiedFunction`.** Two empirically-proven FATALs with asyncify: it
  **serializes `parallel()`** (313ms vs 156ms — concurrency impossible), and a
  host throw **corrupts the VM** on the 2nd agent failure (`cannot handle error
  in suspended function` + use-after-free) — which kills the error contract.
  The `newPromise`/sync bridge fixes both (true overlap + clean error
  propagation) under Bun.
- **Budget must be an isolated nested sub-ledger** (own `AbortController` + one
  reservation debit), never a wrapper over the shared `BudgetLedger` (else a
  workflow within its envelope still trips the global abort and nukes the
  parent).
- **Interactive reservation must be an `eligible()` class-cap against
  `effectiveCapacity()`**, not a priority-class scan reorder (which breaks the
  no-starvation guarantee); shared AIMD contamination argues for giving
  workflows their **own** `SubagentScheduler` instance.
- **Background execution is physically real in the TUI** (event-loop stays alive
  on the stdin listener; detached promises + the unref'd pumpTimer progress),
  but **false for `claude -p`** (force foreground there); next-turn cancellation
  of an outlived run is net-new with no shipped analog; resume keys must include
  a **structural call position** (duplicate `(prompt,opts)` collide).
- **Capability amplification**: workflow agents default to network egress
  (`web_fetch`/`web_search` not denied) — unattended orchestration of net-capable
  agents is new authority in aggregate; default them to no-network, and cap
  worktree count/disk independently of the token budget.
- First-principles caveat: C is **less adaptive** than the in-loop design above;
  its only unique value is unattended off-context scale.
