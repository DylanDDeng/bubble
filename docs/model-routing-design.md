# Bubble Subagent Model Routing — Design (v3.7: autonomous per-task model selection)

Status: **implemented** (Phases 0–3 shipped 2026-07-12; full suite green.
v3 drafted 2026-07-11; v3.1–v3.4 after external review rounds 1–4 — see §11
revision log; round 4 found no new P0. v3.5, 2026-07-12: product decision —
cross-provider routing defaults to OPEN, the gate becomes an opt-out lock,
§7.2. v3.6, 2026-07-12: three field fixes from the first live case — see
§11. v3.7, 2026-07-13: three verified fixes from the Codex review of
PR #61 — see §11). Builds on the shipped
orchestration v2 surface (`workflow-runtime-design.md`, revision 2026-07-06:
`spawn_agent` + `run_workflow` dual path) and the subagent runtime
(`subagent-runtime-design.md`). Key existing code this design extends:
`src/agent.ts` (`resolveRouteForSubagent` ~line 2284 — note the call-site
bare-model resolution at line 2309, §3.5; `getSystemPromptToolOptions` line
382), `src/agent/categories.ts` (`BUILTIN_CATEGORIES` line 31, field-level
merge in `mergeAgentCategories` lines 44–53, `resolveSubagentRoute`),
`src/model-catalog.ts` (`BuiltinModelDefinition` line 14, `listBuiltinModels`
line 196, `getBuiltinModel` line 234, dynamic overlay lines 200–232),
`src/model-config.ts` (models.json schema, `ProviderModelConfig` line 16),
`src/provider-registry.ts` (`getConfigured()` line 232, `getEnabled()` line
301, model discovery: `ModelDiscoveryResult.authoritative` line 56, success/
failure TTLs 60s/10s lines 65–66, cache `expiresAt` line 397,
`performModelDiscovery` line 410 — **its static fallback marks
`authoritative: true` at line ~498, which this design must not trust**,
§1.4; OAuth token auto-refresh writes through `authStorage.set` line ~140),
`src/oauth` `AuthStorage` (mutated *directly* by callers via
`registry.getAuthStorage().set/.remove`, e.g. login
`slash-commands/commands.ts:795`, logout `:925` — §1.6),
`src/tui-ink/model-picker.tsx` (async `registry.discoverModels` at :457/:995
— populates the discovery cache outside any snapshot rebuild, §1.5),
`src/prompt/delegation.ts`, `src/prompt/compose.ts`, `src/system-prompt.ts`,
`src/main.ts` (startup builds the system prompt at line 372 *before*
constructing the Agent at line 404), `src/tui/model-switch.ts` (line ~89),
`src/tui-ink/app.tsx` (`rebuildSystemPrompt` line ~674),
`src/slash-commands/commands.ts` (`switchToProviderModel` +
`syncSystemPrompt` lines ~145–210; `/provider --add/--remove/--set` lines
~695–773; `/logout` no-fallback branch line ~940),
`src/prompt/task-reminders.ts` (`orchestrationRequestReminder` precedent),
`src/tools/agent-lifecycle.ts` (spawn_agent `model`/`category` params lines
139–140; run_workflow `agent()` opts line 420).

---

## 0. Background — what exists, and what the gap actually is

### 0.1 The plumbing is done

Orchestration v2 (shipped 2026-06-29, revised 2026-07-06) gave every child
spawn a full routing chain. `resolveRouteForSubagent` (`agent.ts:2284`)
resolves, in priority order:

```
call-site override (model/effort)  >  profile.model  >  category  >  inherit parent
```

- `spawn_agent` accepts per-call `model` (bare name = parent provider per the
  tool contract — but see §3.5 for a code divergence this design fixes,
  `provider:model` = cross-provider) and `category` (semantic routing key) and
  `effort`.
- `run_workflow` scripts pass the same knobs per `agent()` call:
  `{model, effort, category, agentType, schema, label}`.
- Categories (`src/agent/categories.ts`) map a semantic name to
  `{model, thinkingLevel, maxConcurrent}`, user-extensible via the
  `agentCategories` config key (merged over builtins **field by field**, user
  fields win — this granularity matters, see §3.3).
- Cross-provider children go through `resolveProviderForRoute`
  (`agent.ts:2477`) and the injected `providerFactory`.
- Effort is clamped to what the target model actually supports
  (`normalizeThinkingLevel` against `getAvailableThinkingLevels`), with the
  trusted-metadata guard so unknown/legacy models keep explicit call-site
  effort untouched.

The design intent is on record in the `resolveRouteForSubagent` doc comment:
*"opus for this reviewer, haiku for these twenty scouts"*.

### 0.2 The gap: the model cannot and will not use the plumbing

Three independent deficiencies, confirmed by code inspection 2026-07-11:

1. **No menu.** Nothing in the system prompt tells the model which models,
   providers, or categories are actually available in this session. The
   environment section (`prompt/environment.ts`) names only the parent's own
   provider/model. The only routing documentation the model ever sees is the
   one-line parameter descriptions inside the spawn_agent/run_workflow tool
   schemas. A model that wanted to route a scout to a cheap model would have
   to *guess* a model id from its priors — and cross-provider ids it guesses
   may not even have credentials configured.

2. **No policy.** The delegation policy section (`prompt/delegation.ts`) —
   the one place that teaches *when and how to delegate* — says nothing about
   model selection. It covers when to delegate, spawn vs workflow shape, and
   briefing discipline, but never "mechanical scans go to a fast model,
   judgment keeps the strong one". Absent guidance, the model's prior is to
   omit optional parameters, so every child inherits the parent model.

3. **No default diversity.** All six builtin categories are
   `model: "inherit"` (`categories.ts:31–38`) — out of the box, `category`
   only modulates thinking level, never the model. Real model diversity
   requires the user to hand-write `agentCategories` config, which nobody
   discovers.

Net effect: on a strong (expensive) parent model, a 20-scout fan-out runs 20
copies of the expensive model at full price and latency, even though the
runtime has supported per-call downgrade for two weeks.

### 0.3 The lesson that shapes this design

The 2026-07-06 orchestration-routing revision established empirically (three
rounds of live tests on opus-4.8) that **prompt wording loses to model
priors**: no phrasing of the system prompt reliably made the model pick
`run_workflow` over parallel spawns when the user asked for an "agent team".
What worked was a **deterministic harness detector + a reminder injected at
the decision point** (`orchestrationRequestReminder`,
`prompt/task-reminders.ts:88`). This design applies the same doctrine to
model selection:

- The system prompt establishes *knowledge* (the menu, §4) and *policy* (the
  rules, §5) — necessary but not sufficient.
- A deterministic detector injects a reminder *at the moment the model makes
  a routing mistake* (§6) — that is the lever that actually changes behavior.
- Where a rule is a genuine invariant (cost/billing boundaries), it is
  **enforced at the tool layer**, not merely stated in the prompt (§7.2) — a
  prompt rule the runtime does not enforce must be described as guidance,
  never as a guarantee. And an enforcement gate must hold in **every**
  configuration, including hosts that wire up no routing data at all
  (§7.0).

### 0.4 Design principles

1. **Auto-downgrade only; upgrades are always explicit — and the invariant is
   enforced by a rank comparison, not by curation of the builtin table.**
   Automatic (builtin-tier) routing routes a child **only when the target
   tier ranks strictly below the parent model's tier**; equal, higher, or
   unknown ranks resolve to inherit (§3.2). Upgrading is available, but only
   through an explicit call-site `model`, a user-authored binding, or a
   profile — and "user-authored" is judged **per field**, not per category
   name (§3.3).
2. **Tiers, not model names — and deterministic selection within a tier.**
   Policy and category bindings reference abstract tiers
   (`fast`/`balanced`/`strong`) resolved against the parent provider's
   effective catalog at spawn time, with a selection order that never
   depends on a remote response's array order (§3.2).
3. **Cross-provider routing is open by default, lockable by config.**
   Product decision (v3.5, 2026-07-12): the main agent may freely arrange
   children across configured providers — including from a conversational
   user request ("run this on gemini") — so `agentRouting.allowCrossProvider`
   defaults to `true`. The gate exists as an **opt-out lock** for users who
   want a hard billing/data-residency boundary; when set `false` it is
   enforced at the tool layer on the Agent's own config, **not on catalog
   data** — it holds even when no routing snapshot is available (§7.0), and
   profiles / user-authored category bindings still pass it (standing
   authorization). Note the asymmetry with principle 1: tiers are
   within-provider, so cross-provider choices carry no downgrade guarantee —
   the policy prompt (§5) is the instrument that keeps them purposeful.
4. **One catalog, read live — membership is not metadata.** All
   catalog-dependent consumers — tier resolution, the prompt menu,
   unknown-model validation, the detector — read through a single
   host-provided snapshot accessor that rebuilds lazily when the registry's
   routing revision changes (§1.5); no consumer ever holds catalog data
   older than the current revision. When an authoritative source defines
   the catalog, that source alone decides **which model ids exist**;
   lower-priority sources only *enrich metadata* (§1.3).
5. **Hard rejection only against a catalog that cannot silently expire.**
   The single hard-reject source is a user-authored models.json allowlist.
   Complete remote discovery defines membership (for menu accuracy) but
   never hard-rejects: its 60-second cache TTL means its authority evaporates
   faster than any prompt or conversation turn, and an enforcement rule that
   flips within a turn cannot be represented truthfully to the model (§1.4,
   §11 round 4 items 1–2). Everything non-allowlist warns and allows.
6. **Reminders inform, never block.** The detector (§6) appends one
   informational note per session. It does not veto, rewrite, or re-route the
   model's tool calls (same reasoning as the effort-mismatch reminder,
   `agent-lifecycle.ts:778`). False positives cost one line of noise.
7. **Model switches stay atomic; the routing revision tracks semantic change
   only.** The switch transaction commits provider + model + thinking +
   prompt together (§1.5). The registry's routing revision bumps on changes
   to the *routing world* — provider set, credential identity, models/
   baseURL/protocol config, discovery membership — and explicitly **not** on
   same-account access-token rotation (§1.6).

---

## 1. Component R — the routing catalog: one snapshot, read live

**This component exists because the existing APIs each tell a partial or
misleading story** (§11 rounds 1–4): `listBuiltinModels` misses the dynamic
overlay; `getConfigured()` overstates runnability; the registry's discovery
`authoritative` flag marks static fallbacks authoritative
(`provider-registry.ts:~498`); and any *frozen* snapshot handed to the Agent
goes stale the moment the model picker's async discovery
(`model-picker.tsx:457`) or a `/provider` mutation lands.

### 1.1 Why no existing API suffices

- `listBuiltinModels(providerId)` (`model-catalog.ts:196`) returns **only the
  static `BUILTIN_MODELS` table**. The dynamic overlay is consulted **only**
  by `getBuiltinModel` (`model-catalog.ts:234`), as is the `openai` →
  `openai-codex` catalog aliasing for OpenAI OAuth sessions.
- The dynamic overlay stores **model metadata only** — no completeness,
  identity, or freshness. The registry's discovery cache tracks
  `source`/`authoritative`/`expiresAt` (`provider-registry.ts:56/65/397`)
  but keeps them internal, and its `authoritative` semantics don't match
  this design's (static fallback = `true` there).
- `models.json` (owned by `src/model-config.ts`, **not** `src/config.ts`)
  defines custom models as `{id, name?}` today — no tier, no priority.
- `ProviderRegistry.getConfigured()` (`provider-registry.ts:232`) includes
  providers **without active credentials**; the runtime factory
  (`src/main.ts:138`) requires `enabled && apiKey`. `getEnabled()`
  (`provider-registry.ts:301`) applies the correct filter.

### 1.2 The snapshot shape

New module `src/agent/routing-catalog.ts`:

```ts
export interface RoutingModelEntry {
  id: string;
  name: string;
  tier?: "fast" | "balanced" | "strong";
  /** Deterministic within-tier selection order (§3.2). */
  routingPriority?: number;            // from models.json only
  source: "builtin" | "dynamic" | "custom";   // custom = models.json
}

export interface RoutingSnapshot {
  /** Parent route the snapshot was built for. */
  parent: { providerId: string; model: string; tier?: string };
  /** Catalog-effective provider id (openai OAuth -> "openai-codex" alias). */
  effectiveProviderId: string;
  /** What defined the MEMBERSHIP of `models` (§1.3). */
  membershipSource: "custom-allowlist" | "complete-discovery" | "fallback-union";
  /** Model list for the PARENT provider only (see scope note below). */
  models: RoutingModelEntry[];
  /** True iff membershipSource === "custom-allowlist" (§1.4) — the only
   *  catalog that hard-rejects unknown ids. */
  authoritative: boolean;
  /** Routing revision this snapshot was built at (§1.6). */
  registryRevision: number;
  /** Provider ids with active credentials — from getEnabled(), never
   *  getConfigured(). */
  runnableProviderIds: string[];
  /** Categories post-merge and post-tier-resolution (§3): exactly what a
   *  spawn with that category will do. Menu renders from this. */
  resolvedCategories: Array<{
    name: string;
    model: string | "inherit";
    thinkingLevel?: string;
    tierSource?: "builtin" | "user";   // field-level provenance §3.3
  }>;
}
```

**Scope note — the snapshot holds one provider's catalog, deliberately.**
Unknown-model validation therefore applies to routes that **resolve to the
parent provider** (§7.1 — resolution first, then branch; input syntax does
not choose the branch). Cross-provider routes are validated for
authorization and credentials (§7.2), never against a model catalog.

### 1.3 Membership versus metadata (the closed-world rule)

Two distinct questions, resolved by different rules (§11 round 3, item 1):

**Membership — which model ids exist in this snapshot:**

```
membershipSource = custom-allowlist   (user listed models in models.json)
    -> ids from models.json ONLY. builtin/dynamic ids NOT listed there are
       absent — the allowlist is an allowlist.
membershipSource = complete-discovery (fresh, identity-matched cache — §1.4)
    -> ids from the discovery result ONLY. A builtin model the server did
       not return stays out.
membershipSource = fallback-union     (everything else)
    -> builtin ∪ cached dynamic ∪ custom, deduped by id.
```

**Metadata — what we know about each member id:** enriched per field from
all sources, regardless of membership mode:

```
server metadata (reasoningLevels, contextWindow, toolOutputTokenLimit, …):
    dynamic ?? custom ?? builtin
tier:              dynamic.tier ?? custom.tier ?? builtin.tier
routingPriority:   custom only (models.json is the only place users rank)
```

So a complete discovery that returns `claude-x` without a tier still gets
`claude-x`'s builtin tier annotation; but a builtin model the discovery
*omitted* is not resurrected into membership.

### 1.4 Authority: hard rejection is allowlist-only

The registry grows a narrow read API (this puts `provider-registry.ts` in
the change surface):

```ts
getCachedDiscoverySnapshot(providerId): {
  models: ModelInfo[];
  source: "remote" | "static" | "fallback";
  complete: boolean;        // server-declared-complete catalogs only
  expiresAt: number;        // existing TTLs: 60s success / 10s failure
  identityKey: string;      // stable credential-identity fingerprint (§1.6)
} | undefined
```

Used for **membership** decisions: `complete-discovery` membership requires
`source === "remote"`, `complete === true`, `expiresAt` in the future, and
`identityKey` matching current credentials.

But — a v3.4 simplification (§11 round 4, items 1–2) — **discovery-based
membership no longer drives hard rejection**. v3.3 let a fresh complete
discovery hard-reject unknown ids and re-checked `authoritativeUntil` at
call time; review round 4 showed the remaining half of that contradiction:
the *prompt* still says "choose only from this list" long after the 61st
second, because prompts don't rebuild on a timer. Rather than patch wording
races around a 60-second authority window, the design drops the window:

- `authoritative === true` ⟺ `membershipSource === "custom-allowlist"`.
  A user-authored allowlist does not expire and its prompt wording can be
  safely absolute.
- Complete discovery still produces exact membership — the menu shows the
  server's real catalog — but validation for it is warn-and-allow (§7.1),
  and its menu wording stays conservative (§4).

Explicitly **not** trusted: the registry's existing
`ModelDiscoveryResult.authoritative` flag (static fallbacks are `true`
there, `provider-registry.ts:~498`); the snapshot builder maps registry
state into *this design's* semantics via `source`/`complete` instead.

### 1.5 Ownership and lifecycle: a live accessor, not a frozen object

v3.2/v3.3 handed the Agent a frozen snapshot plus an after-the-fact
staleness fuse checked "when validation runs". Review round 4 closed the
loop on why that shape cannot work: async discovery (model picker,
`model-picker.tsx:457`) updates the registry cache without any host refresh
event, and the fuse did not cover tier auto-routing, detector parent-tier
checks, or category resolution — a stale snapshot could still auto-route to
a model that no longer exists (§11 round 4, items 1 and 5). v3.4 replaces
frozen-plus-fuse with a **live accessor**:

```ts
// Host-side helper in routing-catalog.ts:
createRoutingSnapshotAccessor(registry, agentCategories, agentRouting):
  (parent: { providerId: string; model: string }) => RoutingSnapshot
// Internally: cache keyed by (registry.routingRevision, parent.providerId,
// parent.model); rebuilds lazily on miss. buildRoutingSnapshot is
// synchronous over cached registry state, so a rebuild costs microseconds
// (merge a few dozen model entries + six categories).
```

- The **host** constructs the accessor (it owns the registry) and hands it
  to the Agent (`routingSnapshot?: (parent) => RoutingSnapshot` constructor
  option). The Agent holds no snapshot and no registry — every consumer
  (tier resolution §3.2, detector §6, validation §7, prompt rendering §4)
  calls the accessor at point of use and is therefore **never stale**: a
  discovery completion or `/provider` mutation bumps the routing revision
  (§1.6), and the very next access rebuilds.
- The **rendered prompt string is the one consumer that cannot be live** —
  it is built at discrete moments. Handled by (a) rebuilding it inside every
  switch transaction and after every mutating slash command, and (b) the
  conservative non-allowlist wording (§4) that stays truthful when the menu
  lags the catalog. `agent.getSystemPromptToolOptions()` calls the accessor
  when re-rendering, so any host-triggered rebuild (mode/thinking change
  included) picks up the current catalog — this is what makes "next prompt
  rebuild picks it up" actually true.

**Startup order:** `main.ts` builds the system prompt (line 372) *before*
constructing the Agent (line 404) — the host calls the accessor itself for
the first `modelRoutingPrompt`, then passes the accessor to the
constructor. Feishu run-driver and desktop bridge follow the same order.

**Model switches are a transaction.** Three switch paths today
(`tui/model-switch.ts:89`, `app.tsx:674` `rebuildSystemPrompt`,
`slash-commands/commands.ts` `switchToProviderModel`/`syncSystemPrompt`
~145–210, also behind `/login`/`/logout`) share one pure helper:

```
prepare provider (may fail -> abort, agent untouched)
nextSnapshot = accessor(nextParent)        (pure read)
nextPrompt   = buildSystemPrompt({ ..., modelRoutingPrompt: render(nextSnapshot) })
commit atomically:
  agent.setProvider / model / thinking / setSystemPrompt(nextPrompt)
```

(No snapshot is stored on the agent, so the v3.3 "set snapshot in the
commit" step disappears — the accessor keys on the agent's new parent route
automatically.)

Hosts without a registry (unit tests, embedded) omit the accessor; every
**catalog-dependent** consumer degrades to current behavior (no tier
routing, no menu, no unknown-model validation). The cross-provider
authorization gate does **not** degrade — §7.0.

### 1.6 The routing revision: semantic change only, and observable

`ProviderRegistry` gains a monotonically increasing `routingRevision`. Two
requirements shape it (§11 round 4, item 4):

**(a) It must actually observe mutations.** Callers today mutate auth state
*directly* through the exposed storage object
(`registry.getAuthStorage().set(...)` at `commands.ts:795`, `.remove(...)`
at `:925`), which the registry cannot see. `AuthStorage` therefore gains an
`onMutation(key)` hook the registry subscribes to (chosen over wrapping all
call sites in registry methods: smaller blast radius, existing callers keep
working, and any future direct caller is automatically covered). models.json
reloads and `/provider` add/remove/set already flow through
registry/config methods and bump directly.

**(b) It must ignore non-semantic churn.** OAuth access-token auto-refresh
also calls `authStorage.set` (`provider-registry.ts:~140`); bumping on every
rotation would invalidate the accessor cache after every token renewal for
no routing-relevant reason. On each auth mutation the registry recomputes a
per-provider **identity fingerprint** — derived from stable identity fields
(account id where present, else a refresh-token hash), *not* the access
token — and bumps `routingRevision` only when a fingerprint appears,
disappears, or changes. The same `identityKey` feeds
`getCachedDiscoverySnapshot` (§1.4).

Revision bumps on: provider add/remove/enable/disable; credential identity
appear/change/disappear (login, logout, account switch); models/baseURL/
protocol config changes (models.json reload); **discovery cache writes that
change membership or completeness** (this is what lets the model picker's
async discovery reach the accessor, §1.5). Not on: same-identity token
rotation; discovery cache rewrites with identical membership.

External file edits (models.json/credentials) outside the process are
covered at the next reload, as today.

## 2. Component A — tier metadata

`BuiltinModelDefinition` (`src/model-catalog.ts:14`) gains one optional field:

```ts
/**
 * Relative capability/cost tier within this provider's lineup. Drives
 * rank-guarded category routing (categories.ts) and the routing menu
 * (prompt/routing.ts). Models without a tier never participate in
 * automatic routing (they remain reachable by explicit name).
 */
tier?: "fast" | "balanced" | "strong";
```

Annotation rules:

- Tier is a **within-provider** ordering, not a cross-provider benchmark.
  `fast` = the provider's cheap/low-latency line (haiku, flash, mini,
  highspeed variants), `strong` = its frontier line (opus/fable, gpt-5.x
  full, gemini pro), `balanced` = the middle where one exists (sonnet).
- Providers with a single serious model get no tiers (or a single `strong`);
  the rank guard (§3.2) then resolves everything to inherit.
- models.json model entries gain `tier?` **and `routingPriority?`** —
  `{ id, name?, tier?, routingPriority? }` in `ProviderModelConfig.models`
  (`src/model-config.ts:16`), sanitized on load. Dynamic metadata
  registrations may carry `tier`. Precedence per field as §1.3.

Why a new field rather than inferring from context window or price: the
catalog deliberately holds no price data (non-goals §9), and inference from
names ("mini", "flash") is exactly the kind of fragile heuristic this
codebase has been removing.

## 3. Component B — builtin categories bind tiers, guarded by rank

### 3.1 Config surface

`AgentCategoryConfig` (`src/agent/categories.ts`) gains:

```ts
/** Resolve the model by tier within the parent provider's catalog.
 *  Mutually exclusive with `model`; `model` wins if both are set. */
tier?: "fast" | "balanced" | "strong" | "inherit";
```

Builtin table becomes:

| category | tier      | thinkingLevel | maxConcurrent | semantics                    |
|----------|-----------|---------------|---------------|------------------------------|
| quick    | fast      | low           | 3             | small mechanical tasks       |
| explore  | fast      | low           | 3             | file scanning / search       |
| writing  | inherit   | medium        | 2             | prose, docs, summaries       |
| deep     | inherit   | high          | 2             | deep analysis                |
| review   | inherit   | high          | 2             | review / adjudication        |
| frontend | inherit   | high          | 1             | frontend work                |

`writing` stays inherit in the first release (v3.1 decision, unchanged).

### 3.2 Resolution semantics (rank guard + deterministic selection)

Inside `resolveSubagentRoute`, given a snapshot from the accessor:

```
TIER_RANK = { fast: 0, balanced: 1, strong: 2 }

category has USER-supplied `model`     -> route as asked (may upgrade/cross)
category has USER-supplied `tier`      -> resolve tier in catalog; route
                                          (explicit user intent bypasses guard)
category tier is BUILTIN-sourced:
    autoTier config is false           -> inherit  (kill switch)
    parent tier unknown                -> inherit  (cannot prove downgrade)
    target tier absent in catalog      -> inherit  (no fuzzy cross-tier fallback)
    rank(target) <  rank(parent)       -> route to selected model of that tier
    rank(target) >= rank(parent)       -> inherit  (never sideways/up automatically)
else                                   -> inherit  (current behavior)
```

**Within-tier selection is deterministic and independent of remote response
order** (§11 round 4, item 6 — dynamic discovery order is not stable, not
price-ordered, and not a recommendation). Candidates of the target tier are
ordered by:

```
1. routingPriority ascending          (models.json, user-authored — wins)
2. builtin catalog index              (the provider ordering we maintain)
3. normalized model id, lexicographic (total-order tiebreak for ids known
                                       only from discovery/custom entries)
```

The same `quick` spawn therefore picks the same model across sessions and
across discovery refreshes, unless the user or the builtin table says
otherwise.

Supporting details:

- The parent's tier comes from the snapshot (its own catalog entry). A parent
  running an untiered/unknown model never triggers automatic routing.
- Kill switch: `agentRouting.autoTier` (default `true`). Because the switch
  keys on **tier provenance** (§3.3), `false` disables every builtin-sourced
  tier route — including inside categories the user partially overrode.

### 3.3 Field-level provenance (guard-bypass is per field, not per category)

`mergeAgentCategories` merges **field by field**
(`categories.ts:47–50`: `{...builtin[name], ...userConfig[name]}`). A user
override of only `maxConcurrent` therefore *inherits the builtin tier
through the merge*. If provenance were tracked per category name, that
builtin tier would masquerade as user intent and bypass the rank guard
(§11 round 2, item 1). Therefore the merge records provenance **per
model-determining field**:

```ts
tierSource?: "builtin" | "user";    // "user" ONLY if the user's config
modelSource?: "user";               // object literally contains the `tier`
                                    // (resp. `model`) key
```

Guard-bypass rules read these, never the category name's presence in user
config. `thinkingLevel`/`maxConcurrent` overrides carry no routing
authority.

### 3.4 Route provenance (tracked through the chain, not inferred at the end)

`ResolvedSubagentRoute` gains two fields — the existing `inherited` flag is
**not** reused (it flips false on effort-only overrides while the model is
still the parent's):

```ts
/** True iff providerId+model equal the parent's — regardless of effort. */
modelInherited: boolean;
/** Which precedence layer DECIDED the final model. */
modelSource: "inherit" | "builtin-tier" | "user-category" | "profile" | "callsite";
```

`modelInherited` is computed at the end by value comparison. `modelSource`
**cannot** be — a call-site, profile, or user category that explicitly names
the parent's own model produces the same final value as a true inherit, yet
carries different authority (cross-provider authorization §7.2 keys on it;
the detector §6 distinguishes deliberate choices from defaults). It is
assigned **while applying the precedence chain** inside
`resolveRouteForSubagent` (§11 round 3, item 4):

```ts
let modelSource = "inherit";
category resolved a model            -> "builtin-tier" | "user-category"
                                        (per §3.3 tierSource/modelSource)
profile.model applied                -> "profile"
call-site override.model applied     -> "callsite"
```

An explicit layer that names the parent model still stamps its source
(`modelSource: "callsite"`, `modelInherited: true`).

### 3.5 Call-site bare-model semantics: pinned to the parent provider

The tool contract (`agent-lifecycle.ts:140`) says a bare model name uses
the **parent** provider. Current code disagrees: the call-site override
resolves against `route.providerId` (`agent.ts:2309`) — a provider that
category or profile may already have switched. Example: parent on OpenAI, a
profile routes to Anthropic, call-site passes bare `gpt-x` → today that is
interpreted as an *Anthropic* model. This corrupts the priority chain,
flips cross-provider detection, and would pick the wrong validation catalog
(§11 round 3, item 5).

**Decision: the tool contract wins.** Phase 0 changes `agent.ts:2309` to
resolve call-site bare names against `parentRoute.providerId` (matching how
`profile.model` already resolves, line 2302). Behavior change only in the
narrow case "category/profile crossed providers AND call-site passed a bare
name" — rare, previously surprising, documented in the changelog. §7's
validation is specified against this pinned semantic and normalizes with
the same rule (§7.1).

Priority chain is unchanged: call-site `model` > profile.model >
category(tier) > inherit.

## 4. Component C — the routing menu in the system prompt

New module `src/prompt/routing.ts`: `buildModelRoutingPrompt(snapshot)`
renders the section; `compose.ts` places it immediately after the delegation
policy, **gated identically** (present only when `spawn_agent` is in the tool
list — child agents never see it, same as delegation policy today).

Rendered shape (compact; hard target ≤ 14 lines):

```
## Subagent model routing
Parent model: anthropic claude-fable-5 (strong tier).
Categories (category → what a spawn actually gets):
  quick → claude-haiku-4-5 + low · explore → claude-haiku-4-5 + low ·
  writing → inherit + medium · deep → inherit + high ·
  review → inherit + high · frontend → inherit + high
Models on this provider, usable via per-call `model`:
  claude-haiku-4-5 (fast) · claude-sonnet-5 (balanced) ·
  claude-opus-4-8 (strong) · claude-fable-5 (strong)
  (list may lag the provider; explicit ids not listed are allowed)
Cross-provider routing (provider:model) is available for providers with
credentials: openai, grok.
```

Wording rules — the prompt must never promise more enforcement than the
runtime delivers at any later moment (§11 round 4, item 2):

- **Absolute wording** (`Choose only from this list; do not invent model
  ids.`) is used **only** when `snapshot.authoritative` — i.e. a models.json
  allowlist, which cannot silently expire. This matches §7.1's hard
  rejection exactly.
- **Every other membership source** — including a currently-fresh complete
  discovery — gets the conservative line
  `(list may lag the provider; explicit ids not listed are allowed)`,
  because discovery authority evaporates on a 60-second TTL while the
  rendered prompt lives for the whole conversation. The runtime for these
  catalogs warns-and-allows (§7.1), so prompt and validator agree at every
  point in time, not just at render time.
- The cross-provider line renders from `agentRouting.allowCrossProvider`:
  the default (open) wording above lists `runnableProviderIds`; when the
  user locked it (`false`) it reads `Cross-provider routing (provider:model)
  is disabled in this session.` The menu never advertises an option the
  tool layer would reject, in either direction.

Consistency rules:

- **All same-provider models from the snapshot are listed**, tiered or not
  (untiered entries appear without a tier tag). Tier is an annotation, not a
  listing filter. If the list exceeds 12 entries, tiered models are listed
  first and the tail collapses to `… and N more; any explicit id from this
  provider is valid`.
- The category block shows **post-resolution** bindings from
  `snapshot.resolvedCategories` — including user overrides and rank-guard
  outcomes — so the menu never advertises a route that resolves differently.

Freshness: the prompt string is rebuilt on every switch transaction, every
mutating slash command, and every host-triggered rebuild — each rebuild
calls the live accessor (§1.5), so it reflects the catalog as of the last
rebuild; the conservative wording keeps it truthful in between.

## 5. Component D — routing policy in the delegation section

Append to `DELEGATION_POLICY` (`src/prompt/delegation.ts`), keeping the
section's established two-sided style (every positive trigger paired with a
negative guard, per the 2026-06-12 review doctrine):

```
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
the default frame.
```

Why this lives in the delegation section and not the tool description: tool
descriptions are reference material consulted *after* the model decides to
call the tool; the delegation section is read as behavioral policy.

## 6. Component E — decision-point detector (the lever that works)

Per §0.3, prompts establish knowledge; the detector changes behavior. All
trigger conditions are deterministic, and all counting happens on
**resolved routes at dispatch time**, never on source text. The detector
reads the parent tier through the live accessor (§1.5), so it can never
judge against a stale catalog.

**Signal**: `modelSource === "inherit"` (§3.4) — the child's model was
decided by *no* routing layer at all. Deliberately narrower than
`modelInherited`: a call-site/profile/category that explicitly names the
parent model shows the author already made a routing decision, and nagging
about deliberate choices erodes the reminder's authority. It is also
strictly stronger than the legacy `inherited` flag, which an effort-only
override flips false (three strong-model children spawned with only
`effort: low` still count here).

**Trigger — an absolute count, not a proportion** (§11 round 3, item 7):
within one assistant turn (spawn path) or one workflow run (counted as the
runtime dispatches each `agent()` call), the number of dispatches with
`modelSource === "inherit"` reaches N (default **3**) while the parent
model's tier is `strong`. Children that *were* routed elsewhere do not
reset or dilute the count. Fires at the Nth qualifying dispatch; for
workflows the reminder attaches at the next parent-facing surfacing point
(progress/result delivery, alongside the lifecycle reminder).

**Action**: append a system-reminder line riding the existing reminder
channel next to `buildSubagentLifecycleReminder`
(`src/agent/subagent-lifecycle-reminder.ts:20`):

```
Routing note: N children in this fan-out defaulted to the parent's
strong-tier model (no model/category given). If any of these tasks are
mechanical (scan / summarize / search / extract), route them with category
"quick"/"explore" or a fast-tier model next time. If they genuinely need
this model, ignore this note.
```

**Once per session**: a boolean on the agent, set on first fire, covering
both paths jointly. Repeating it every fan-out trains the model to ignore
reminders in general (observed failure mode of noisy reminder channels).

**Never blocks, never rewrites.**

**Telemetry before tuning**: per-turn/per-run defaulted-fan-out counts,
parent tier, and fire events are traced from day one, so threshold N and
the strong-parent gate are calibrated on live data. N=3 rationale: 1–2
strong-model children are often a single deep side-investigation; at 3+
uniform defaults the odds that *all* need frontier capability drop sharply.
Timing caveat: the reminder lands after the Nth child has started — it
teaches the *next* fan-out; the menu and policy (§4–5) are the
before-the-fact half.

## 7. Component F — early validation with actionable errors

Validation runs at tool-argument time, in `src/tools/agent-lifecycle.ts`
(spawn) and the workflow dispatch path.

### 7.0 What degrades without an accessor — and what never does

The **cross-provider authorization gate does not depend on catalog data**
(§11 round 3, item 2): the Agent holds its routing config directly,
independent of any accessor/snapshot:

```ts
// Agent constructor option:
agentRouting: {
  autoTier: boolean;           // default true
  allowCrossProvider: boolean; // default true (v3.5) — set false to lock
}
```

Degradation table:

| check | needs | without accessor |
|---|---|---|
| cross-provider lock (§7.2.1, when `allowCrossProvider: false`) | `agentRouting` + `modelSource` | **always enforced** |
| cross-provider credentials (§7.2.2) | snapshot `runnableProviderIds` | skipped → factory fails late (today's behavior) |
| same-provider unknown model (§7.1) | snapshot catalog | skipped |
| tier auto-routing (§3.2) | snapshot catalog | inherit (feature absent) |
| menu (§4) | snapshot | absent |

(The v3.3 "stale snapshot" row is gone: with the live accessor §1.5 there
is no stale-snapshot state — consumers get current data or, with no
accessor wired, none.)

### 7.1 Same-provider unknown model — normalize first, then branch

Validation **never branches on input syntax** (§11 round 4, item 3: a
qualified-but-same-provider id like `anthropic:invented-model` on an
Anthropic parent is neither "bare" nor "cross-provider" and would fall
between syntax-based branches). Every call-site `model` value is first
normalized with the same rule the router uses (§3.5):

```ts
const resolved = resolveModelRoute(input, parentRoute.providerId);
if (resolved.providerId === parentRoute.providerId) -> §7.1 same-provider path
else                                                -> §7.2 cross-provider path
```

Same-provider path — model id not found in `snapshot.models`:

- `snapshot.authoritative === true` (models.json allowlist — the only
  non-expiring closed world, §1.4) → tool error:
  `Unknown model "X" for provider "P". Available: a (fast), b (balanced), c (strong), d.`
  The model self-corrects in the same turn.
- otherwise (fallback-union **and** complete-discovery membership) → allow
  the call, appending a one-line note that the model id is unrecognized
  locally. The provider is the authority; local knowledge only warns.

### 7.2 Cross-provider: authorization first, then credentials

For routes whose **resolved** provider differs from the parent's:

1. **The lock** (accessor-independent — §7.0): `allowCrossProvider`
   defaults to `true` (v3.5 product decision: the main agent freely
   arranges cross-provider children, and conversational requests like "run
   this on gemini" work with zero friction). When the user sets it
   `false`, call-site cross-provider routes are rejected — tool error:
   `Cross-provider routing is disabled in this session's config.` — while
   routes whose `modelSource` is `"profile"` or `"user-category"` still
   pass (the config that created them is standing user authorization;
   §3.4's chain-tracked provenance is what makes this test sound). The
   lock is for environments where the billing/data-residency boundary must
   be hard; open-by-default trades that hardness for fluidity, with the
   policy prompt (§5) and the credentials check below as the remaining
   guardrails.
2. **Credentials** (accessor-dependent): target provider must be in
   `snapshot.runnableProviderIds` → otherwise:
   `Provider "P" is not configured with active credentials. Available: anthropic, openai, grok.`
   Today this surfaces late as the developer-facing factory error at
   `agent.ts:2477`. Skipped when no accessor is wired (§7.0) — the factory
   error remains the backstop.
3. **Near-match correction, then no hard catalog check** (v3.6 amendment).
   The provider remains the authority — a genuinely unknown id proceeds with
   a note. But when the target provider's local catalog (routable-model
   index, §7.4) contains a **near match** (normalized prefix in either
   direction — "gpt-5.6" against gpt-5.6-sol/-terra/-luna), that is positive
   evidence of a mistyped id: soft-reject with
   `Unknown model "X" for provider "P". Did you mean: a, b, c?` so the model
   corrects within the turn. Live case 2026-07-12: a Grok-4.5 parent
   invented `openai:gpt-5.6` for a user-requested gpt-5.6-sol; three
   children burned 400s before recovery. Novel ids (no near candidates)
   still pass — this never blocks a genuinely new model.

### 7.3 User-named model resolution (v3.6)

When the user's message names a configured model, the harness — not the
parent's priors — resolves it. A deterministic detector
(`userNamedModelReminder`, `prompt/task-reminders.ts`, same doctrine as
`orchestrationRequestReminder` §0.3) normalizes the user text
(case/punctuation-insensitive) against the **routable-model index** (§7.4)
and, on a hit, injects a decision-point reminder with the exact ids:

```
The user's message names these configured models. Exact routable ids:
- "GPT-5.6-Sol" → openai:gpt-5.6-sol
- "GLM-5.2" → zhipuai:glm-5.2 (also on: zai)
Use these exact ids in spawn_agent / run_workflow `model` params; do not
retype model ids from memory.
```

Matching is against a closed catalog (min normalized key length 5), so a
miss is silent — zero standing prompt cost, no false-positive noise. Gated
on spawn_agent like every routing surface.

### 7.4 The routable-model index

`createRoutableModelIndex(registry)` (routing-catalog.ts): a revision-cached
list of every `provider:model` reachable across **runnable** providers
(custom ∪ dynamic ∪ builtin per provider, openai-OAuth aliased to the codex
catalog). Ids and names only — no metadata, no per-provider validation
catalogs (that non-goal stands). Consumers: the user-named reminder (§7.3)
and near-match correction (§7.2.3, plus a did-you-mean enrichment of the
§7.1 non-authoritative note). Hosts wire it alongside the snapshot accessor;
absent index degrades to v3.5 behavior.

Effort handling is untouched: existing clamp + mismatch-reminder logic
already does the right thing.

---

## 8. Change surface

| file | change |
|---|---|
| `src/agent/routing-catalog.ts` (new) | `RoutingSnapshot` + `buildRoutingSnapshot` (membership vs metadata §1.3, allowlist-only authority §1.4, deterministic within-tier ordering §3.2) + `createRoutingSnapshotAccessor` (revision-keyed lazy cache §1.5) + switch-transaction helper |
| `src/provider-registry.ts` | `getCachedDiscoverySnapshot` (source/complete/expiresAt/identityKey §1.4); `routingRevision` with semantic-only bump rules incl. discovery-membership writes §1.6; per-provider identity fingerprint (stable across token rotation) |
| `src/oauth` (`AuthStorage`) | `onMutation` hook so the registry observes direct `set`/`remove` calls (login `commands.ts:795`, logout `:925`) §1.6 |
| `src/model-catalog.ts` | `tier` on `BuiltinModelDefinition`; annotate builtin models; expose an overlay-listing helper for the snapshot builder |
| `src/model-config.ts` | `tier?` + `routingPriority?` on models.json model entries (`ProviderModelConfig.models`); sanitize on load |
| `src/agent/categories.ts` | `tier` on `AgentCategoryConfig` + sanitizer; rank guard + deterministic selection (§3.2); field-level provenance through the merge (§3.3); rebind quick/explore |
| `src/agent.ts` | constructor `agentRouting` (§7.0) + `routingSnapshot` accessor option; **fix call-site bare-model resolution to `parentRoute.providerId` (line 2309, §3.5)**; chain-tracked `modelSource` + computed `modelInherited` §3.4; detector counters + once-per-session flag; `getSystemPromptToolOptions` re-renders the menu via the accessor |
| `src/prompt/routing.ts` (new) | `buildModelRoutingPrompt(snapshot)` with §4 wording rules (absolute only for allowlist) |
| `src/prompt/compose.ts` | accept and place `modelRoutingPrompt` (after delegation) |
| `src/system-prompt.ts` | pass-through of `modelRoutingPrompt` in `SystemPromptOptions` |
| `src/main.ts` | create accessor, render first menu **before** `buildSystemPrompt` (line 372), hand accessor to Agent (line 404); config plumb for `agentRouting` |
| `src/tui/model-switch.ts` | atomic switch via the shared transaction helper (§1.5) |
| `src/tui-ink/app.tsx` | `rebuildSystemPrompt` re-renders via accessor; switch path uses the transaction |
| `src/slash-commands/commands.ts` | switch paths join the transaction; `/provider --add/--remove/--set`, `/login`, `/logout` (incl. no-fallback branch) rebuild prompt after mutation §1.5–1.6 |
| `src/feishu/agent-host/run-driver.ts`, desktop bridge | accessor created before prompt, handed at agent construction |
| `src/prompt/delegation.ts` | append the Routing policy paragraph |
| `src/agent/subagent-lifecycle-reminder.ts` (or sibling) | detector reminder text + emission alongside lifecycle reminder |
| `src/tools/agent-lifecycle.ts` | validation §7 (normalize-first branching, §7.0 degradation table); workflow dispatch-time route accounting hook |
| `src/config.ts` | sanitize `tier` in `agentCategories`; `agentRouting` (`autoTier`, `allowCrossProvider`) |

Tests (following existing suites `orchestration-v2.test.ts`,
`delegation-policy.test.ts` patterns) — incorporating all risk cases from
review rounds 2–4:

- snapshot membership: models.json allowlist does not re-admit builtin-only
  ids; complete discovery does not resurrect omitted builtin ids;
  fallback-union includes all three sources; metadata enrichment still
  applies to member ids.
- authority: `authoritative` true only for custom-allowlist; complete
  discovery — even fresh — warns instead of hard-rejecting; static-builtin
  fallback never authoritative despite the registry's internal flag.
- accessor freshness: **discovery completion (revision bump) means the next
  accessor read and next prompt re-render include the new catalog**;
  same-identity token rotation does NOT bump revision or invalidate the
  cache; identity change (login/logout/account switch) does;
  **revision change means quick/explore tier routing immediately uses the
  new catalog — no stale auto-route**; direct `AuthStorage.set/remove`
  callers are observed via `onMutation`.
- field-level metadata merge: dynamic entry without tier keeps
  custom/builtin tier; dynamic tier wins when present; openai OAuth →
  openai-codex aliasing.
- deterministic selection: **shuffled discovery order yields the same
  within-tier pick**; `routingPriority` beats builtin order beats id
  tiebreak.
- categories/rank guard + provenance: strictly-lower routes; equal/higher/
  unknown parent tier inherits; missing target tier inherits;
  `maxConcurrent`-only user override stays under the rank guard;
  user-supplied `tier`/`model` bypasses; `autoTier: false` disables
  builtin-tier routing even in partially-overridden categories.
- route provenance: call-site/profile/user-category explicitly naming the
  parent model each yield their own `modelSource` with
  `modelInherited: true`; effort-only override keeps
  `modelSource: "inherit"`.
- bare/qualified semantics (§3.5, §7.1): profile crosses provider →
  call-site bare name resolves against the parent provider;
  **`parent-provider:unknown-model` (qualified, same provider) goes through
  same-provider validation, not the cross-provider path**.
- switch transaction & mutations: prompt-build failure leaves model,
  provider, prompt unchanged; all three switch paths rebuild the menu;
  `/provider --remove` and no-fallback `/logout` rebuild prompt; menu
  wording stays conservative for discovery-based catalogs (**no absolute
  wording that a TTL expiry would falsify**).
- detector: fires at 3 defaulted children on strong parent; 3 defaulted +
  1 explicitly-routed still fires; explicit call-site naming the parent
  model does not count; fires when children differ only in effort; not at
  2; not on non-strong parent; once per session across both paths; workflow
  dispatch-time counting.
- validation: allowlist unknown-model error lists catalog; non-allowlist
  allows with note; **default config allows call-site cross-provider**;
  the lock (`allowCrossProvider: false`) rejects call-site cross-provider
  **even with no accessor wired**, while profile/user-category
  `modelSource` routes still pass it; credential check lists runnable ids,
  skipped without accessor (factory backstop); cross-provider model ids
  never checked against the parent catalog.
- delegation prompt: policy paragraph present, gated on spawn_agent.

## 9. Non-goals

- **No price/cost accounting.** Tiers are ordinal, not monetary.
- **No mid-flight model switching** for a running child.
- **No conversational unlock of the cross-provider lock.** With the
  default-open gate (§7.2) none is needed; when a user has locked it,
  only config/profile changes reopen it — chat text never does (a
  heuristic authorization gate is what §0.3 says not to build).
- **No per-provider catalogs in the snapshot.** Unknown-model validation
  applies to routes resolving to the parent provider; the target provider
  is the authority for its own model space.
- **No discovery-based hard rejection.** A 60-second-TTL authority cannot
  honestly back an absolute prompt promise or a hard runtime gate (§1.4).
- **No per-task-type classifier for routing.** The model chooses; the
  harness informs and validates.
- **No live credential probing.** `runnableProviderIds` reflects stored
  credentials, not a health check.
- **No async discovery inside the snapshot builder.** It consumes cached
  registry state; freshness arrives via the routing revision (§1.5–1.6).
- **No timer-driven prompt refresh.** Prompt strings are rebuilt on
  transactions, mutations, and host rebuilds; in-between truthfulness comes
  from conservative wording, not timers (§4).

## 10. Phasing

Ordered so each phase leaves the system in a consistent, shippable state:

- **Phase 0 — R + provenance + transactions (pure refactor; one narrow
  documented behavior change).** Registry: `routingRevision` +
  identity fingerprints + `AuthStorage.onMutation` +
  `getCachedDiscoverySnapshot`. Routing catalog: snapshot builder with
  membership/metadata separation + accessor + switch-transaction helper,
  wired through all hosts, switch paths, and mutation commands. Agent:
  `agentRouting` (cross-provider default-open matches today's
  unconditional behavior, so the lock ships dark — no behavior change),
  `modelSource`/`modelInherited` chain-tracking, category field-level
  provenance, §3.5 bare-model fix (the one documented behavior change).
  Membership, authority, accessor-freshness, transaction, and provenance
  tests land here.
- **Phase 1 — A + B (tier metadata + rank-guarded bindings).** Catalog
  annotations incl. `routingPriority`; quick/explore → fast behind
  `agentRouting.autoTier` (default on). `writing` stays inherit.
- **Phase 2 — C + D (menu + policy).** Rendered via the accessor through
  every prompt-build path; wording rules of §4.
- **Phase 3 — F then E (validation, then detector).** Validation first;
  detector last, telemetry from day one, threshold N revisited against
  live traces.

## 11. Revision log

**v3.1 (2026-07-11)** — review round 1 of v3.0; six findings, all verified
and accepted: (1) rank guard — exact-tier selection could upgrade a fast
parent; (2) `RoutingSnapshot` — `listBuiltinModels` misses the dynamic
overlay; (3) runnable providers from `getEnabled()`; (4) detector signal
split from the legacy `inherited` flag; (5) menu self-contradictions;
(6) `/model` prompt-rebuild wiring; (7, P2) dispatch-time counting replaces
the workflow regex scan.

**v3.2 (2026-07-11)** — review round 2 of v3.1; seven findings, all
verified and accepted: (1, P0) field-level category provenance;
(2) parent-provider-only snapshot scope; (3) field-level metadata merge;
(4) third switch path + atomic transaction; (5) cross-provider became a
runtime gate; (6) `authoritative` restricted, builder is cached-only;
(7) models.json schema is in `model-config.ts`.

**v3.3 (2026-07-11)** — review round 3 of v3.2; seven findings, all
verified and accepted: (1, P0) membership vs metadata separation — a union
defeats allowlists and resurrects server-omitted models; (2, P0)
cross-provider gate made snapshot-independent; (3) discovery
authority/freshness/identity API — the registry's own flag marks static
fallbacks authoritative (`provider-registry.ts:~498`), verified; (4)
`modelSource` tracked through the chain, not inferred from final values;
(5) call-site bare-model semantics pinned to the parent provider
(`agent.ts:2309` divergence verified); (6) registry revision + refresh for
non-switch mutations (`/provider`, no-fallback `/logout` verified at
`commands.ts:695/940`); (7) detector trigger fixed to an absolute count of
defaulted children.

**v3.4 (2026-07-11)** — review round 4 of v3.3 (no new P0; "core
architecture sound, close the snapshot-lifetime loop"); six findings, all
verified and accepted:

1. *(P1)* Discovery completions never reached the frozen snapshot — the
   model picker's async `discoverModels` (`model-picker.tsx:457`, verified)
   only fills the registry cache, and non-switch rebuilds re-rendered the
   old snapshot. Fixed structurally: frozen snapshot replaced by a
   revision-keyed **live accessor** (§1.5); discovery membership writes bump
   the routing revision (§1.6).
2. *(P1)* TTL expiry left absolute prompt wording contradicting the
   downgraded validator. Fixed by removing the contradiction's source:
   discovery-based catalogs never hard-reject and never get absolute
   wording; hard enforcement is models.json-allowlist-only (§1.4, §4 —
   adopted the review's "simplest fix" and extended it to the validator).
3. *(P1)* Qualified same-provider ids (`anthropic:invented` on an Anthropic
   parent) fell between the bare-name and cross-provider branches. Fixed:
   normalize via `resolveModelRoute` first, branch on the resolved provider
   (§7.1).
4. *(P1)* The revision could not observe direct `AuthStorage` mutations
   (login `commands.ts:795`, logout `:925`, verified) and would have churned
   on OAuth token auto-refresh (`provider-registry.ts:~140`). Fixed:
   `AuthStorage.onMutation` + identity fingerprints — revision bumps on
   identity/presence change, never on same-account token rotation (§1.6).
5. *(P1)* The staleness fuse only covered validation, leaving tier
   auto-routing/detector/prompt-categories reading stale data. Fixed by the
   same live-accessor restructure as item 1: every consumer reads at point
   of use; the stale-snapshot state no longer exists (§1.5, §7.0).
6. *(P2)* "First model of the tier" depended on remote response order.
   Fixed: deterministic within-tier ordering — `routingPriority` (new
   models.json field) > builtin catalog index > normalized-id tiebreak
   (§3.2).

**v3.7 (2026-07-13)** — three fixes from the Codex review of PR #61 (all
three claims verified against source before adopting):

1. **Discovery-TTL snapshot invalidation** (§1.5): the accessor cached by
   (revision, parent) only, but TTL expiry is passive — it bumps no
   revision — so a snapshot built from complete discovery outlived its
   60s TTL until an unrelated registry mutation. Snapshots now record
   `discoveryExpiresAt` (the consumed discovery's expiry) and the accessor
   rebuilds past that instant, matching what a fresh build would return.
2. **Near-match direction** (§7.2.3): `nearModelMatches` matched
   normalized prefixes in both directions, so a cataloged `gpt-5.6-sol`
   hard-rejected the plausibly-real longer variant
   `gpt-5.6-sol-20260701` as a "typo". The hard-reject path now uses
   `mode: "truncation"` (catalog extends input only); soft "did you
   mean" notes keep both directions.
3. **Truncated-allowlist wording** (§4): with >12 allowlisted models the
   prompt printed "any explicit id from this provider is valid" next to
   "Choose only from this list" while validation hard-rejected unlisted
   ids. The remainder note and the closing line are now
   authoritative-aware; open catalogs keep the original wording.

**v3.6 (2026-07-12)** — three fixes from the first live case (a Grok-4.5
parent running "use GLM-5.2 and gpt 5.6 sol as an agent team"):

1. **User-named model resolution** (§7.3) + **routable-model index** (§7.4)
   + **near-match soft-reject** (§7.2.3 amendment). Root cause: the menu
   lists only same-provider models, so cross-provider ids rode entirely on
   the parent's priors — Grok invented `openai:gpt-5.6`. Per the §0.3
   doctrine, the harness now resolves user-named models deterministically
   and corrects near-miss ids at dispatch.
2. **Category effort re-anchored after a model override**
   (`resolveRouteForSubagent`): a category's thinkingLevel is calibrated for
   the model the category resolved; when profile/call-site replaces the
   model, an unsupported level now falls back to the final model's own
   default instead of the downward clamp — explore's "low" + call-site
   glm-5.2 ([high/max/off]) had silently landed on "off", disabling
   thinking on a thinking-default flagship.
3. **Workflow failure-semantics wording** (delegation policy + run_workflow
   tool description): "failed agent() resolves to null" holds only inside
   parallel()/pipeline(); a bare await propagates and fails the run. The
   live script's bare-await synthesis turned one member's 400 into a
   whole-run failure despite 4/6 members completing. Runtime semantics kept
   (clean error propagation is intentional); the prompts now say so and
   advise wrapping must-not-die steps.

**v3.5 (2026-07-12)** — product decision by the user (not a review round):
cross-provider routing opens up. `agentRouting.allowCrossProvider` default
flips `false → true`: the main agent may freely arrange children across
configured providers, and conversational requests ("run this on gemini")
work without config friction. The gate is retained as an **opt-out lock**
with unchanged enforcement semantics (accessor-independent, profile/
user-category routes always pass — §7.2); menu wording gains an
open-variant line (§4); the delegation policy gains judicious-use guidance
since tiers do not compare across providers (§5). Side effect: Phase 0
loses its "default-deny" behavior change — default-open matches today's
unconditional cross-provider behavior, so the lock ships dark (§10).
