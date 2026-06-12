# Bubble Subagent Runtime Roadmap

> **Superseded:** the planning sections of this document are superseded by
> [`subagent-runtime-design.md`](./subagent-runtime-design.md) (review-hardened
> design, 2026-06-12). This file is kept for the original decision record and
> baseline notes.

## Decision

Build a stronger subagent runtime before building a visible multi-agent team
system.

The product shape should stay simple: one parent Bubble agent owns the user
conversation, decomposes work, spawns focused children, integrates their output,
and verifies the final result. Team-style concepts such as member-to-member
mailboxes, shared team task boards, and tmux panes are later orchestration modes,
not the next foundation.

The useful reference from oh-my-openagent is not the public "team" surface. The
useful parts are:

- semantic routing by work category instead of model name;
- background child sessions with explicit lifecycle and status;
- bounded parallel fan-out for exploration;
- accumulated learnings passed from earlier children to later children;
- write-capable workers isolated behind patch or worktree boundaries.

## Current Bubble Baseline

Bubble already has the right first layer:

- `src/tools/agent-lifecycle.ts` exposes `spawn_agent`, `wait_agent`,
  `send_input`, and `close_agent`.
- `src/agent.ts` stores in-process child records in `subagentThreads`.
- `src/agent.ts` can run child agents asynchronously and stream
  `subagent_update` events back into the parent tool row.
- `src/agent/profiles.ts` has built-in profiles, user/project profile loading,
  tool filtering, nickname assignment, and reserved `write_patch` /
  `write_worktree` modes.
- `docs/subagent-design-sketch.md` documents the Phase 1 constraints:
  read-only children, no recursive delegation, no child replay log, and no
  direct writes.

The next step is to turn this into a runtime with routing, scheduling,
observability, and controlled write boundaries.

## Target Architecture

```text
User
  |
  v
Parent Bubble Agent
  - decomposes work
  - chooses categories/profiles
  - spawns children
  - integrates results
  - applies or rejects patches
  - verifies final behavior
  |
  +-- Subagent Runtime
      |
      +-- Profile + Category Resolver
      |   - maps agent_type/category to profile, model, tools, mode
      |
      +-- Background Scheduler
      |   - queues children
      |   - enforces concurrency
      |   - tracks status and cancellation
      |
      +-- Child Agent Runner
      |   - creates isolated child Agent instances
      |   - sends live updates
      |   - writes final summaries
      |
      +-- Result Integrator
          - stores learnings
          - returns summaries, patch artifacts, or worktree paths
```

This is still parent-led orchestration. Children do not coordinate with each
other in the default mode.

## User-Facing Tool Contract

Keep the existing lifecycle tools and extend them carefully.

### `spawn_agent`

Current shape stays valid:

```jsonc
{
  "agent_type": "explorer",
  "message": "Find the auth config load path.",
  "fork_context": false
}
```

Add optional fields:

```jsonc
{
  "category": "deep"
}
```

Rules:

- `agent_type` selects identity and tool policy.
- `category` selects model/variant defaults.
- `mode` is defined by the selected profile, not by the tool call. A readonly
  profile cannot be escalated into write mode from `spawn_agent`.
- `fork_context` remains opt-in because parent context can be noisy and
  expensive.

Future phases can add scheduler/write fields such as `priority`,
`write_scope`, and explicit patch/worktree controls. Do not add those to Phase A.

### `wait_agent`

Keep current behavior, but make status richer:

- `completed`: final summary or artifact ready.
- `failed`: child crashed or provider failed.
- `blocked`: policy, approval, missing tool, or trust gate blocked it.
- `cancelled`: parent/user/runtime cancelled it.
- `running`: returned only on timeout.

### `send_input`

Keep it for targeted follow-up. Do not use it as a chat protocol between
children. It is parent-to-child steering only.

### `close_agent`

Keep it as cancellation/cleanup. Closing a running child should cancel its
abort signal and mark the child result as cancelled.

## Category Routing

Add a category layer next to profile resolution.

Suggested built-ins:

| Category | Use | Default model behavior |
| --- | --- | --- |
| `quick` | small local lookup or narrow check | inherit or fastest configured model |
| `deep` | multi-file investigation, debugging, architecture | best configured reasoning model |
| `explore` | cheap repository reconnaissance | fast model, read/search tools |
| `review` | critique plan/patch/test gaps | high-reasoning model, readonly |
| `frontend` | UI/UX and visual implementation planning | visual/frontend-preferred model |
| `writing` | docs, release notes, prose | prose-friendly model |

Config shape:

```jsonc
{
  "agentCategories": {
    "quick": {
      "model": "inherit",
      "thinkingLevel": "low",
      "maxConcurrent": 3
    },
    "deep": {
      "model": "openai:gpt-5.5",
      "thinkingLevel": "high",
      "maxConcurrent": 2
    },
    "frontend": {
      "model": "google:gemini-2.5-pro-preview-03-25",
      "thinkingLevel": "high",
      "maxConcurrent": 1
    }
  }
}
```

Phase A config source is user config only. Project-local profile files may
reference a category only after the existing project-profile trust gate is
passed, but project files do not define category defaults in Phase A. This keeps
model routing under the user's control.

Important runtime boundary: Bubble's current `Agent` owns one active provider
instance. If a category can route to a different provider than the parent, the
runtime must add a provider factory first. Passing `provider:model` into a child
while reusing the parent provider is not enough.

Minimum router contract:

```ts
interface ModelRoute {
  providerId: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

interface ResolvedSubagentRoute {
  category?: string;
  providerId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  inherited: boolean;
}

interface SubagentRouteResolver {
  resolveCategory(category: string | undefined, parent: ModelRoute): ResolvedSubagentRoute;
}
```

Phase A shipped same-provider categories first. Cross-provider routing requires
a provider factory injected into `Agent`; without one, a child route that names a
different provider must be blocked before any provider call is made.

Phase A route application must update all three execution surfaces:

- child system prompt: configured provider/model/thinking labels reflect the
  resolved route;
- child `Agent` construction: `model` and `thinkingLevel` use the resolved route;
- child metadata: route/category are visible through `wait_agent`, final tool
  results, and TUI updates.

If a category resolves to a different provider than the active parent provider,
the subagent runtime must create a provider instance for the child route instead
of reusing the parent provider. If that provider is not configured, the child is
blocked with a clear error.

## Background Scheduler

The current registry starts children immediately. The next runtime should add a
scheduler around it.

Responsibilities:

- enforce global `maxActiveSubagents`;
- enforce per-category concurrency;
- keep queued children visible in the TUI;
- preserve parent abort and child abort semantics;
- prevent recursive delegation unless explicitly enabled in a later phase;
- expose a read-only status snapshot to the TUI and tools.

Proposed data model:

```ts
interface SubagentJob {
  agentId: string;
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  profileName: string;
  category: string;
  mode: "readonly" | "write_patch" | "write_worktree";
  task: string;
  priority: "low" | "normal" | "high";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

Do not persist this as a full child transcript yet. Persist only enough parent
metadata to show final results on resume.

## Accumulated Learnings

Add a parent-owned notepad for multi-step runs. This is not a memory system and
not a team mailbox. It is a compact execution ledger the parent can inject into
later child prompts.

Suggested buckets:

- `conventions`: repo patterns discovered by children;
- `decisions`: choices the parent made after reading child output;
- `gotchas`: failed commands, wrong assumptions, provider/tool issues;
- `verification`: commands run and results;
- `openQuestions`: unresolved issues that need parent/user attention.

Runtime behavior:

1. Child finishes.
2. Parent receives summary and tool notes.
3. Parent or a small deterministic extractor updates the notepad.
4. Later children receive a short "Known context from prior children" block.

This gives most of the value of team coordination without letting children chat
with each other.

## Write-Capable Workers

Do not jump from readonly children to direct writes. Add write capability in two
steps.

### Step 1: `write_patch`

The child can return a patch artifact but cannot mutate the working tree.

Result shape:

```ts
interface PatchArtifact {
  kind: "patch";
  baseRevision?: string;
  files: Array<{
    path: string;
    action: "add" | "modify" | "delete";
    patch: string;
  }>;
  summary: string;
  verification?: string[];
}
```

Parent responsibilities:

- inspect the patch;
- reject paths outside `write_scope`;
- apply through the existing edit/write path or `apply_patch`;
- run verification;
- summarize what was accepted.

### Step 2: `write_worktree`

The child runs in an isolated worktree or copied temp workspace. This should
come only after `write_patch` is stable.

Requirements:

- create and clean worktree safely;
- prevent writes to parent cwd;
- detect changed files;
- expose diff to parent;
- parent applies or cherry-picks explicitly;
- cancellation cleans up partial worktrees.

## Ink TUI Experience

Keep it understated. The user should not have to manage an agent team.

Collapsed row:

```text
Subagents  3 running  1 queued  2 done
```

Expanded row:

```text
Ada      explorer  running   read src/agent.ts
Grace    review    done      found 2 test gaps
Linus    worker    queued    patch plan for profile resolver
```

Rules:

- show child nickname, profile/category, status, and latest tool note;
- do not show separate chat panes by default;
- do not expose child-to-child messaging because default orchestration is
  parent-led;
- final parent-visible output should remain concise and model-readable.

### Ink Interaction Rules

The Ink UI should treat subagents as a tool result with live status, not as a
new workspace surface.

Placement:

- render subagents inside the parent transcript where the lifecycle tool call
  appears;
- keep the composer and approval/question flows unchanged;
- never open a separate agent panel, tab, or member list in Phase A.

Default state:

- collapsed by default while children are running;
- show one compact summary line with counts by status;
- include the currently most active child note when space allows;
- final completed rows remain visible in transcript history like other tool
  results.

Expanded state:

- toggled with the existing tool-detail interaction pattern;
- show one fixed-height list row per child;
- row columns are nickname, profile/category, status, latest note;
- truncate long task names and tool notes instead of wrapping the whole
  transcript row;
- sort running and blocked children first, then queued, then completed.

Status language:

```text
queued      waiting for capacity
running     reading src/agent.ts
completed   found 3 relevant files
blocked     category crosses provider boundary
failed      provider request failed
cancelled   stopped by parent
```

Errors:

- blocked and failed children get one red detail line when expanded;
- collapsed summary shows only counts, not full stack traces;
- provider/config errors should state the next corrective action when known.

Streaming:

- child text deltas should not stream as transcript prose;
- child tool activity updates the latest note;
- final child answer appears only inside the subagent tool block and the
  model-visible tool result.

Phase A Ink scope:

- show category/profile metadata in final tool rows;
- support live `subagent_update` merging only if it can be done without
  destabilizing the transcript render path;
- if live updates are not completed in Phase A, the final row still must show
  category, status, summary, and error metadata.

## Team-Lite Later

After background scheduling and write workers are stable, add a small
orchestration layer:

- `plan_run_create`: create a parent-owned execution run;
- `plan_task_create`: create tasks assigned to subagents;
- `plan_task_update`: update status;
- `plan_run_status`: summarize progress.

This is a shared task list, not a peer mailbox. The parent is still the only
coordinator. Full team mode is only justified if we later need:

- child-to-child handoff;
- long-lived members;
- durable child sessions;
- independent worktrees per member;
- external visualization such as tmux panes.

## Implementation Phases

### Phase A: Category Routing

- Extend `AgentProfile` with optional `category`.
- Add `agentCategories` to config parsing.
- Resolve `agent_type + category` into profile, model route, thinking level,
  tool set, and mode.
- Start with same-provider model routing if provider-factory injection is not
  ready.
- Add tests for category fallback and profile override precedence.
- Do not add scheduler fields, write scope, or write-capable modes in this
  phase.

### Phase B: Scheduler

- Introduce `SubagentScheduler` around the current `subagentThreads` map.
- Add global and per-category concurrency.
- Keep queued jobs visible through `wait_agent` and TUI updates.
- Add cancellation for queued and running jobs.
- Add tests for queue order, timeout behavior, and parent abort.

### Phase C: Ink Observability

- Improve `subagent_update` aggregation in the Ink path.
- Add latest tool note, category, queued/running counters, and concise errors.
- Ensure child stream noise does not pollute the parent transcript.
- Add snapshot tests for compact and expanded subagent rows.

### Phase D: Learnings

- Add a parent-owned execution notepad in memory only.
- Inject summarized learnings into later child prompts.
- Add explicit bounds so the notepad cannot grow without limit.
- Add tests that later children receive prior conventions but not full child
  transcripts.

### Phase E: Patch Workers

- Enable `mode: "write_patch"` profiles.
- Add patch artifact schema and validation.
- Enforce `write_scope`.
- Add parent apply flow and verification handoff.
- Add tests for rejected paths, malformed patches, and accepted patch metadata.

### Phase F: Worktree Workers

- Enable `mode: "write_worktree"` only behind config.
- Create isolated worktrees, collect diffs, and clean up.
- Add explicit parent apply/cherry-pick flow.
- Add tests for cleanup, cancellation, and conflict reporting.

## First Implementation Slice

Start with Phase A only. Do not touch write-capable workers yet.

Files to introduce:

- `src/agent/categories.ts`: category schema, built-in defaults, config merge,
  and category resolution.
- `src/__tests__/agent-categories.test.ts`: config merge, defaults, invalid
  category handling, and parent-model inheritance.

Files to extend:

- `src/config.ts`: add optional `agentCategories`.
- `src/agent/profiles.ts`: add optional `category` on `AgentProfile` and parse
  it from profile frontmatter.
- `src/tools/agent-lifecycle.ts`: add `category` to `spawn_agent` arguments and
  pass it into the runtime. Do not add `mode`, `write_scope`, or `priority` yet.
- `src/agent.ts`: store category/model route metadata on
  `SubagentThreadRecord`; apply same-provider model/thinking overrides during
  child `Agent` construction.
- `src/agent/subagent-control.ts` and `src/types.ts`: carry route/category
  through snapshots, results, tool updates, and metadata.
- `src/tui-ink/app.tsx` and `src/tui-ink/message-list.tsx`: show category next
  to profile when present and merge `subagent_update` events when the Ink render
  path can do so safely. If live updates are not handled in the same slice, the
  Ink final tool row still shows category metadata.

Phase A should end with:

- `spawn_agent({ category: "deep", ... })` accepted and visible in metadata.
- Unknown categories return a clear blocked/error result.
- Category defaults can override model and thinking level only when they stay on
  the active provider.
- Cross-provider category routes are either executed through the configured
  provider factory or blocked with a message that the target provider is not
  configured.
- Existing `agent_type` behavior remains unchanged when no category is passed.

Required Phase A tests:

- category config defaults are parsed from user config;
- project profiles can reference only already-known categories and still require
  `allowProjectAgents`;
- unknown categories are rejected before spawning a child;
- same-provider category overrides change child model and thinking level;
- cross-provider category overrides are blocked before provider calls;
- category appears in `SubagentThreadSnapshot`, `SubagentRunResult`, final tool
  metadata, and `subagent_update` metadata;
- existing `spawn_agent` tests pass unchanged when `category` is omitted.

## Non-Goals For Now

- No child-to-child mailbox.
- No visible "team member" management surface.
- No nested teams.
- No direct writes from children to the parent worktree.
- No durable child transcript replay.
- No tmux visualization.

## Acceptance Criteria

The runtime is ready for real feature work when:

- the parent can spawn multiple children without blocking the UI;
- categories choose predictable models or fall back to inherit;
- queued and running children are visible and cancellable;
- child results are concise, evidence-backed, and recoverable through
  `wait_agent`;
- parent abort cancels all children;
- a failed child does not corrupt the parent run;
- patch workers cannot write outside their declared scope;
- tests cover routing, scheduling, cancellation, TUI metadata, and patch
  validation.
