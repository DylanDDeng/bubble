# Subagent Design Sketch

## Goal

Add first-class subagents to Bubble without introducing a subprocess runtime.
Phase 1 should turn the existing read-only `task` subtask runner into a named,
profile-driven subagent system that supports:

1. Codex-style lifecycle delegation through `spawn_agent`, `wait_agent`,
   `send_input`, and `close_agent`.
2. Random nickname assignment for every child thread.
3. Live child progress in the existing TUI tool row.

Phase 1 explicitly does not implement chained workflows, direct-write workers,
or durable child session replay.

## Current Starting Point

Bubble already has the minimum runtime needed for in-process subagents:

- `src/tools/task.ts` delegates through `ctx.agent.runSubtask(...)`.
- `src/agent.ts` creates a child `Agent` in `runSubtask`, filters tools, injects
  a subtask reminder, and returns a concise summary.
- `src/agent/subtask-policy.ts` defines read-only policy presets, max turns,
  and task budgets.
- `src/tools/index.ts` registers `task` with the normal tool registry.

The missing pieces are profile discovery, a formal event bridge, shared budget
accounting, prompt composition for child identities, and a stable user-facing
tool contract.

## Non-Goals

- No subprocess or JSONL child process bridge.
- No `chain` mode in Phase 1.
- No recursive subagents.
- No write-capable worker in Phase 1.
- No independent child session log or replay UI in Phase 1.
- No project-local subagent execution without explicit trust handling.

## Agent Profiles

Profiles are Markdown files with YAML frontmatter and a body. The body is the
child agent profile prompt, not a transient reminder.

Locations:

- User profiles: `~/.bubble/agents/*.md`
- Project profiles: `.bubble/agents/*.md`

Default scope is user profiles only. Project profiles require both
`agentScope: "project"` or `"both"` and `allowProjectAgents: true` on
`spawn_agent`. This is an explicit trust gate because project profile prompts
are repository-controlled files.

Example:

```markdown
---
name: scout
description: Fast read-only codebase reconnaissance.
mode: readonly
model: inherit
tools:
  preset: readonly
  include: []
  exclude: []
maxTurns: 6
approval: fail
nicknameCandidates:
  - Scout
  - Surveyor
---

You are a scout. Find relevant files, symbols, and evidence quickly.
Return concise findings with file paths and line numbers.
```

### Profile Schema

```ts
interface AgentProfile {
  name: string;
  description: string;
  source: "user" | "project" | "builtin";
  filePath?: string;
  mode: "readonly" | "write_patch" | "write_worktree";
  model?: string | "inherit";
  tools: AgentProfileTools;
  maxTurns?: number;
  approval: "fail" | "disabled";
  nicknameCandidates?: string[];
  prompt: string;
}

interface AgentProfileTools {
  preset: "readonly" | "none" | "explicit";
  include?: string[];
  exclude?: string[];
}
```

Phase 1 only accepts `mode: "readonly"`. The write modes are reserved so Phase 2
can add patch/worktree workers without changing the profile shape.

`tools` accepts either a preset string (`readonly`, `none`, `explicit`), an
object with `preset/include/exclude`, or a YAML list. A YAML list is treated as
`{ preset: "explicit", include: [...] }`.

Built-in role names follow the Codex CLI shape: `default`, `explorer`, and
`worker`. The old `builtin:search`, `builtin:security_investigation`,
`builtin:evidence_correlation`, and `builtin:general_readonly` profiles remain
as compatibility aliases for the legacy `task` surface.

`nicknameCandidates` is optional. If omitted, Bubble uses its built-in nickname
pool. The runtime picks a nickname at spawn time and avoids reusing active
nicknames when possible. The profile name remains the role/config identity; the
nickname is the user-facing child-thread identity.

### Tool Selection

Tool selection is deterministic:

1. Start from the profile preset.
2. Add `include`.
3. Remove `exclude`.
4. Always remove recursive delegation tools: `subagent`, `task`,
   `spawn_agent`, `wait_agent`, `send_input`, and `close_agent`.
5. Remove any tool whose `effect` is not `"read"`.
6. Remove deferred or MCP tools unless explicitly included.

Presets:

- `readonly`: `read`, `glob`, `grep`, `lsp`, `web_search`, `web_fetch`,
  `memory_search`, `memory_read_summary`, `skill`, `todo_write`.
- `none`: no tools.
- `explicit`: only `include`.

Deferred and MCP tools do not enter `readonly` automatically. A profile may
explicitly include a known deferred/MCP tool name, but Phase 1 still requires
the tool to have `effect: "read"` before it can run inside a subagent.

### Tool Effects

Add an explicit effect field to `ToolRegistryEntry`:

```ts
type ToolEffect = "read" | "write_patch" | "write_direct" | "unknown";

interface ToolRegistryEntry {
  effect?: ToolEffect;
}
```

Defaults:

- Built-in read-only tools explicitly set `effect: "read"`.
- `write`, `edit`, and mutating tools set `effect: "write_direct"`.
- Future patch-only tools set `effect: "write_patch"`.
- MCP, deferred, and custom tools default to `effect: "unknown"` and are denied
  inside Phase 1 subagents unless explicitly classified.

`readOnly` remains the plan-mode gate. `effect` is the subagent capability gate.

## Codex-Style Lifecycle Tools

The only user-facing subagent model is lifecycle-based, matching Codex CLI's
user-facing shape:

- `spawn_agent`: starts a child thread and returns `agent_id` plus a random
  nickname.
- `wait_agent`: waits for one or more spawned child threads to complete.
- `send_input`: sends follow-up input to an existing child thread. If the child
  is still running, `interrupt: true` cancels and redirects it.
- `close_agent`: cancels and closes a child thread.

`spawn_agent` accepts `agent_type`, `message`, and `fork_context`. `agent_type`
maps to the Markdown profile name and defaults to `default`. `fork_context`
defaults to `false`; when enabled it copies recent parent conversation while
filtering out lifecycle tool calls and subagent tool results.

The runtime stores spawned children in an in-process registry keyed by
`agent_id`. Each registry entry tracks:

```ts
interface SubagentThreadSnapshot {
  agentId: string;
  runId: string;
  nickname: string;
  agentName: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "closed";
  task: string;
  summary: string;
}
```

The older one-shot `subagent` tool is intentionally not registered. Models
should use `spawn_agent` plus `wait_agent` for delegation.

## Built-In Profiles And Task Migration

Codex-style role profiles:

- `default`
- `explorer`
- `worker`

The existing `subtaskType` values become built-in profiles:

- `builtin:search`
- `builtin:security_investigation`
- `builtin:evidence_correlation`
- `builtin:general_readonly`

The old `task` tool maps:

```ts
subtaskType ?? "general_readonly" -> builtin profile
```

It then calls the same internal runner used by lifecycle subagents. The returned content starts
with a short compatibility note:

```text
Note: task is deprecated. Use spawn_agent with a named profile instead.
```

## Prompt Composition

Do not pass the full parent system prompt directly into the child as-is.

Add a first-class profile slot to prompt composition:

```ts
interface ComposeSystemPromptOptions {
  agentProfilePrompt?: string;
}
```

Child prompt order:

1. Provider identity prompt for Bubble.
2. Environment prompt for the child tool list and cwd.
3. Runtime prompt for mode and guidelines.
4. Agent profile prompt.
5. Subagent policy reminder.
6. Skills and memory prompt only when the selected profile tools include those
   capabilities.

The profile prompt is durable child identity. The policy reminder is still a
runtime reminder because it can vary per invocation.

## Event Bridge

Current `ToolExecutor` only returns a final `ToolResult`. Phase 1 needs a child
event bridge so the TUI is not a black box during long or parallel runs.

Add an optional update callback to the tool context:

```ts
type ToolUpdate = {
  type: "subagent_update";
  parentToolCallId: string;
  runId: string;
  subAgentId: string;
  agentName: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  childEvent?: AgentEvent;
  summaryDelta?: string;
  toolName?: string;
  toolCallId?: string;
  message?: string;
};

interface ToolContext {
  emitUpdate?: (update: ToolUpdate) => void;
}
```

The `Agent.run` loop forwards `emitUpdate` calls as a new `tool_update` event:

```ts
type AgentEvent =
  | ...
  | { type: "tool_update"; id: string; name: string; update: ToolUpdate };
```

TUI behavior:

- Collapsed subagent row shows agent name, count, and current status.
- Expanded row shows per-child status and recent tool summaries.
- Text deltas are buffered into a per-child summary preview.
- The final parent tool result remains the model-visible artifact.

## Session Log

Phase 1 stores only the parent lifecycle tool result in the normal session log.
Child events are not flattened into the main transcript and do not create child
session files.

Final metadata shape:

```ts
interface SubagentToolMetadata {
  kind: "subagent";
  runId: string;
  mode: "single" | "parallel";
  agentScope: "user" | "project" | "both";
  subagents: Array<{
    subAgentId: string;
    agentName: string;
    status: "completed" | "failed" | "blocked" | "cancelled";
    profileSource: "user" | "project" | "builtin";
    task: string;
    summary: string;
    toolNotes: string[];
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    error?: string;
  }>;
}
```

This keeps resume simple and avoids committing to a replay format too early.

## Budget Ledger

Introduce a shared `BudgetLedger` for parent and children:

```ts
interface BudgetLedger {
  readonly signal: AbortSignal;
  recordUsage(usage: TokenUsage, source: { runId: string; subAgentId?: string }): void;
  snapshot(): { spent: number; limit?: number; exhausted: boolean };
}
```

Rules:

- Parent and all child agents share the same ledger.
- There is no hidden per-child token hard budget.
- If a configured shared limit is exhausted, the ledger aborts in-flight parent
  and child calls through the shared signal.
- Child provider calls receive a signal composed from parent abort and explicit
  child cancellation; the shared ledger signal is handled by the child Agent.

## Approval And Safety

Subagents never ask the user interactive approval questions in Phase 1.

Profile `approval` values:

- `fail`: keep the tool in the registry, but any call requiring
  `approval.request(...)` returns a blocked result immediately.
- `disabled`: remove tools that can require `approval.request(...)` from the
  child registry before the run starts.

Non-interactive safety rules always apply:

- Sensitive paths remain blocked.
- Explicit deny rules remain blocked.
- Plan-mode read-only restrictions remain active.
- `effect !== "read"` is denied.

This means a subagent may investigate ordinary source files and allowed web
resources, but it cannot escalate into a permission prompt or write workflow.

## Cancellation

All children receive a composed abort signal:

1. Parent run abort signal.
2. Budget ledger abort signal.
3. Per-child timeout or cancellation signal.

When the user presses Ctrl-C:

- The parent run aborts.
- All active child runners receive abort.
- Partial child results are marked `cancelled`.
- The parent tool result is returned as cancelled if possible; otherwise the
  run raises the existing `AgentAbortError`.

## Parallel Semantics

Parallel mode is not a coordination protocol. It is a bounded fan-out/fan-in
read-only investigation:

- Each child receives only its own task and profile prompt.
- Children do not communicate with each other.
- Results are returned in request order.
- A child failure does not fail the whole batch unless all children fail.
- Budget exhaustion cancels remaining children and returns partial summaries.
- Approval blocked events count as child failures.

## Phase 2 Contract

Phase 2 can add write-capable workers without changing Phase 1 profile shape:

- `mode: "write_patch"` means the child may produce a patch artifact only.
- `mode: "write_worktree"` means the child runs in an isolated worktree.
- `write_direct` is not allowed for subagents by default.

Phase 2 still needs separate design for:

- Patch artifact format.
- Worktree creation and cleanup.
- Parent approval and apply flow.
- Verification ownership.
- Conflict handling.

## Implementation Order

1. Add `ToolEffect` and classify built-in tools.
2. Add profile parser/discovery and built-in profiles.
3. Add prompt composition slot for `agentProfilePrompt`.
4. Add `BudgetLedger` and wire parent/child usage accounting.
5. Add `emitUpdate` support to tool execution and TUI subagent rendering.
6. Implement lifecycle tools and remove the one-shot `subagent` tool from the public registry.
7. Convert `task` to the compatibility wrapper.
8. Add parallel mode with default concurrency `2`.
9. Add tests for schema, tool filtering, prompt composition, budget abort,
   approval fail-fast, task compatibility, and Ctrl-C propagation.

## Required Tests

- User profile discovery parses frontmatter and body.
- Project profiles are ignored by default.
- Project profile execution requires explicit scope.
- Profile tools deny `subagent`, `task`, `effect: "write_direct"`, and
  `effect: "unknown"`.
- `task` maps every legacy `subtaskType` to a built-in profile.
- Spawned subagents emit child updates before final result.
- Lifecycle subagents include stable `runId` and `subAgentId` in every update.
- Parallel respects default concurrency `2`.
- Shared budget abort cancels active children.
- Parent abort cancels active children.
- Approval `fail` returns blocked instead of opening UI.
- Final session log contains only the parent tool result plus metadata.
