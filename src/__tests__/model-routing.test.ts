/**
 * Subagent model routing (docs/model-routing-design.md v3.5).
 *
 * Covers the review-mandated risk cases: membership vs metadata separation,
 * allowlist-only authority, field-level tier merge, deterministic within-tier
 * selection, rank guard + field-level category provenance, chain-tracked
 * route provenance, bare/qualified call-site semantics, the cross-provider
 * lock (with and without an accessor), early validation, the defaulted
 * fan-out detector, and routing-revision semantics.
 */

import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import {
  mergeAgentCategoriesWithProvenance,
  resolveSubagentRoute,
  selectTierCandidates,
  type TierRoutingContext,
} from "../agent/categories.js";
import {
  buildRoutingSnapshot,
  createRoutingSnapshotAccessor,
  DEFAULT_AGENT_ROUTING,
  nearModelMatches,
  sanitizeAgentRouting,
  type AgentRoutingConfig,
  type RoutableModelEntry,
  type RoutableModelIndex,
  type RoutingSnapshot,
  type RoutingSnapshotAccessor,
} from "../agent/routing-catalog.js";
import { buildModelRoutingPrompt } from "../prompt/routing.js";
import { userNamedModelReminder } from "../prompt/task-reminders.js";
import { composeSystemPrompt } from "../prompt/compose.js";
import { discoverAgentProfiles, findAgentProfile, type AgentProfile } from "../agent/profiles.js";
import type { CachedDiscoverySnapshot, ModelInfo, ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import type { Provider, StreamChunk } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers

function defaultProfile(): AgentProfile {
  return findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
}

function textProvider(): Provider {
  return {
    async *streamChat() {
      yield { type: "text", content: "Handoff summary with plenty of detail for the parent agent to use. ".repeat(3) } satisfies StreamChunk;
      yield { type: "done" } satisfies StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

interface StubRegistryOptions {
  providerId?: string;
  customModels?: ModelInfo[];
  discovery?: CachedDiscoverySnapshot;
  enabled?: Array<Partial<ProviderProfile> & { id: string }>;
  revision?: number;
  oauth?: boolean;
}

/** Minimal registry stub: exactly the surface buildRoutingSnapshot consumes. */
function stubRegistry(options: StubRegistryOptions = {}): ProviderRegistry {
  const providerId = options.providerId ?? "anthropic";
  const profile: ProviderProfile = {
    id: providerId,
    name: providerId,
    baseURL: "https://example.invalid",
    apiKey: "key",
    enabled: true,
    authType: options.oauth ? "oauth" : "api",
  };
  const enabled = (options.enabled ?? [{ id: providerId }]).map((entry) => ({ ...profile, ...entry }));
  return {
    getConfigured: () => [profile, ...enabled.filter((item) => item.id !== providerId)],
    getEnabled: () => enabled,
    getModelConfig: () => ({ getCustomModels: () => options.customModels ?? [] }),
    getCachedDiscoverySnapshot: () => options.discovery,
    getRoutingRevision: () => options.revision ?? 0,
  } as unknown as ProviderRegistry;
}

const ANTHROPIC_PARENT = { providerId: "anthropic", model: "claude-fable-5" };

function snapshotFor(options: StubRegistryOptions = {}, parent = ANTHROPIC_PARENT): RoutingSnapshot {
  return buildRoutingSnapshot(stubRegistry(options), parent, {}, { ...DEFAULT_AGENT_ROUTING });
}

function accessorFor(options: StubRegistryOptions = {}, routing?: Partial<AgentRoutingConfig>): RoutingSnapshotAccessor {
  const agentRouting = sanitizeAgentRouting(routing ?? {});
  const registry = stubRegistry(options);
  return createRoutingSnapshotAccessor(registry, () => ({}), () => agentRouting);
}

// ---------------------------------------------------------------------------
// §1.3 membership vs metadata

describe("routing snapshot membership (§1.3)", () => {
  it("models.json allowlist does not re-admit builtin-only ids", () => {
    const snapshot = snapshotFor({
      customModels: [
        { id: "allowed-a", name: "Allowed A", providerId: "anthropic" },
        { id: "allowed-b", name: "Allowed B", providerId: "anthropic", tier: "fast" },
      ],
    });
    expect(snapshot.membershipSource).toBe("custom-allowlist");
    expect(snapshot.models.map((model) => model.id).sort()).toEqual(["allowed-a", "allowed-b"]);
    expect(snapshot.models.some((model) => model.id === "claude-fable-5")).toBe(false);
    expect(snapshot.authoritative).toBe(true);
  });

  it("complete discovery does not resurrect builtin ids the server omitted", () => {
    const snapshot = snapshotFor({
      discovery: {
        models: [{ id: "claude-fable-5", name: "Claude Fable 5", providerId: "anthropic" }],
        source: "remote",
        complete: true,
        expiresAt: Date.now() + 60_000,
        identityKey: "acct",
      },
    });
    expect(snapshot.membershipSource).toBe("complete-discovery");
    expect(snapshot.models.map((model) => model.id)).toEqual(["claude-fable-5"]);
    // Omitted builtin (opus/haiku/sonnet) must NOT be unioned back in.
    expect(snapshot.models.some((model) => model.id === "claude-opus-4-8")).toBe(false);
  });

  it("fallback-union includes builtin models when nothing authoritative exists", () => {
    const snapshot = snapshotFor();
    expect(snapshot.membershipSource).toBe("fallback-union");
    const ids = snapshot.models.map((model) => model.id);
    expect(ids).toContain("claude-fable-5");
    expect(ids).toContain("claude-haiku-4-5-20251001");
    expect(snapshot.authoritative).toBe(false);
  });

  it("complete discovery is never authoritative (hard rejection is allowlist-only, §1.4)", () => {
    const snapshot = snapshotFor({
      discovery: {
        models: [{ id: "claude-fable-5", name: "Claude Fable 5", providerId: "anthropic" }],
        source: "remote",
        complete: true,
        expiresAt: Date.now() + 60_000,
        identityKey: "acct",
      },
    });
    expect(snapshot.authoritative).toBe(false);
  });

  it("enriches discovery members with builtin tier metadata (field-level merge)", () => {
    const snapshot = snapshotFor({
      discovery: {
        models: [
          { id: "claude-fable-5", name: "Claude Fable 5", providerId: "anthropic" },
          { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", providerId: "anthropic" },
        ],
        source: "remote",
        complete: true,
        expiresAt: Date.now() + 60_000,
        identityKey: "acct",
      },
    });
    // Discovery entries carry no tier; the builtin annotation must survive.
    expect(snapshot.models.find((model) => model.id === "claude-fable-5")?.tier).toBe("strong");
    expect(snapshot.models.find((model) => model.id === "claude-haiku-4-5-20251001")?.tier).toBe("fast");
    expect(snapshot.parent.tier).toBe("strong");
  });

  it("aliases openai OAuth onto the openai-codex catalog", () => {
    const snapshot = buildRoutingSnapshot(
      stubRegistry({ providerId: "openai", oauth: true }),
      { providerId: "openai", model: "gpt-5.6-terra" },
      {},
      { ...DEFAULT_AGENT_ROUTING },
    );
    expect(snapshot.effectiveProviderId).toBe("openai-codex");
    expect(snapshot.models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(snapshot.parent.tier).toBe("strong");
  });
});

// ---------------------------------------------------------------------------
// §3.2 deterministic within-tier selection

describe("deterministic within-tier selection (§3.2)", () => {
  it("orders by routingPriority, then builtin index, then id — never input order", () => {
    const shuffled = [
      { id: "zz-fast", tier: "fast" as const },
      { id: "aa-fast", tier: "fast" as const },
      { id: "builtin-fast", tier: "fast" as const, builtinIndex: 2 },
      { id: "priority-fast", tier: "fast" as const, routingPriority: 1 },
    ];
    const pick = selectTierCandidates(shuffled, "fast").map((entry) => entry.id);
    expect(pick).toEqual(["priority-fast", "builtin-fast", "aa-fast", "zz-fast"]);
    const reversed = selectTierCandidates([...shuffled].reverse(), "fast").map((entry) => entry.id);
    expect(reversed).toEqual(pick);
  });
});

// ---------------------------------------------------------------------------
// §3.2–3.3 rank guard + field-level provenance

describe("rank guard and category provenance (§3.2–3.3)", () => {
  const parent = { providerId: "anthropic", model: "claude-fable-5", thinkingLevel: "high" as const };
  const tierContext: TierRoutingContext = {
    parentTier: "strong",
    models: [
      { id: "claude-haiku-4-5-20251001", tier: "fast", builtinIndex: 3 },
      { id: "claude-sonnet-4-6", tier: "balanced", builtinIndex: 2 },
      { id: "claude-fable-5", tier: "strong", builtinIndex: 0 },
    ],
    autoTier: true,
  };

  it("routes quick/explore to the fast tier under a strong parent", () => {
    for (const category of ["quick", "explore"]) {
      const resolution = resolveSubagentRoute(category, parent, {}, tierContext);
      expect("route" in resolution && resolution.route.model).toBe("claude-haiku-4-5-20251001");
      expect("route" in resolution && resolution.route.categoryModelSource).toBe("builtin-tier");
    }
  });

  it("inherits when the parent tier is unknown (cannot prove downgrade)", () => {
    const resolution = resolveSubagentRoute("quick", parent, {}, { ...tierContext, parentTier: undefined });
    expect("route" in resolution && resolution.route.model).toBe("claude-fable-5");
  });

  it("inherits when the target tier is not strictly cheaper (fast parent)", () => {
    const fastParent = { ...parent, model: "claude-haiku-4-5-20251001" };
    const resolution = resolveSubagentRoute("quick", fastParent, {}, { ...tierContext, parentTier: "fast" });
    expect("route" in resolution && resolution.route.model).toBe("claude-haiku-4-5-20251001");
  });

  it("inherits when the target tier has no catalog model", () => {
    const resolution = resolveSubagentRoute("quick", parent, {}, {
      ...tierContext,
      models: tierContext.models.filter((model) => model.tier !== "fast"),
    });
    expect("route" in resolution && resolution.route.model).toBe("claude-fable-5");
  });

  it("keeps builtin tier under the rank guard when the user only overrides maxConcurrent", () => {
    const merged = mergeAgentCategoriesWithProvenance({ quick: { maxConcurrent: 5 } });
    expect(merged.quick.config.tier).toBe("fast");
    expect(merged.quick.provenance.tierSource).toBe("builtin");
    // And the kill switch still bites through the partial override:
    const off = resolveSubagentRoute("quick", parent, { quick: { maxConcurrent: 5 } }, { ...tierContext, autoTier: false });
    expect("route" in off && off.route.model).toBe("claude-fable-5");
  });

  it("user-supplied tier bypasses the rank guard (explicit user intent)", () => {
    const merged = mergeAgentCategoriesWithProvenance({ review: { tier: "balanced" } });
    expect(merged.review.provenance.tierSource).toBe("user");
    const resolution = resolveSubagentRoute("review", parent, { review: { tier: "balanced" } }, {
      ...tierContext,
      parentTier: undefined, // even with unknown parent tier
    });
    expect("route" in resolution && resolution.route.model).toBe("claude-sonnet-4-6");
    expect("route" in resolution && resolution.route.categoryModelSource).toBe("user-category");
  });

  it("explicit category model beats tier", () => {
    const resolution = resolveSubagentRoute("quick", parent, { quick: { model: "claude-opus-4-8" } }, tierContext);
    expect("route" in resolution && resolution.route.model).toBe("claude-opus-4-8");
    expect("route" in resolution && resolution.route.categoryModelSource).toBe("user-category");
  });

  it("autoTier kill switch restores inherit for builtin tiers", () => {
    const resolution = resolveSubagentRoute("quick", parent, {}, { ...tierContext, autoTier: false });
    expect("route" in resolution && resolution.route.model).toBe("claude-fable-5");
  });
});

// ---------------------------------------------------------------------------
// §3.4–3.5 route provenance + bare/qualified semantics (through the Agent)

describe("route provenance and call-site semantics (§3.4–3.5)", () => {
  function agentWith(accessor?: RoutingSnapshotAccessor, routing?: Partial<AgentRoutingConfig>): Agent {
    return new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessor,
      agentRouting: routing,
    });
  }

  it("tracks modelSource through the chain: callsite naming the parent model stays 'callsite'", async () => {
    const agent = agentWith(accessorFor());
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "claude-fable-5",
    });
    expect(snapshot.route?.modelSource).toBe("callsite");
    expect(snapshot.route?.modelInherited).toBe(true);
  });

  it("effort-only override keeps modelSource 'inherit' with modelInherited true", async () => {
    const agent = agentWith(accessorFor());
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      effort: "low",
    });
    expect(snapshot.route?.modelSource).toBe("inherit");
    expect(snapshot.route?.modelInherited).toBe(true);
    // Legacy flag flips false on effort-only override — the detector must not use it.
    expect(snapshot.route?.inherited).toBe(false);
  });

  it("builtin category tier routing stamps modelSource 'builtin-tier'", async () => {
    const agent = agentWith(accessorFor());
    const snapshot = await agent.spawnSubAgent("scan", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      category: "quick",
    });
    expect(snapshot.route?.model).toBe("claude-haiku-4-5-20251001");
    expect(snapshot.route?.modelSource).toBe("builtin-tier");
    expect(snapshot.route?.modelInherited).toBe(false);
  });

  it("call-site bare model resolves against the PARENT provider even when a profile crossed providers", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "openai",
      model: "gpt-4o",
      tools: [],
    });
    const profile: AgentProfile = { ...defaultProfile(), model: "anthropic:claude-opus-4-8" };
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "s1",
      model: "gpt-4o-mini",
    });
    // Tool contract §3.5: bare name = parent provider (openai), NOT the
    // profile-switched provider (anthropic).
    expect(snapshot.route?.providerId).toBe("openai");
    expect(snapshot.route?.model).toBe("gpt-4o-mini");
    expect(snapshot.route?.modelSource).toBe("callsite");
  });
});

// ---------------------------------------------------------------------------
// §7 validation

describe("early validation (§7)", () => {
  it("default config allows call-site cross-provider (v3.5 open default)", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessorFor({ enabled: [{ id: "anthropic" }, { id: "openai" }] }),
    });
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "openai:gpt-4o",
    });
    expect(snapshot.route?.providerId).toBe("openai");
  });

  it("the lock rejects call-site cross-provider EVEN WITH NO accessor wired (§7.0)", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      agentRouting: { allowCrossProvider: false },
    });
    await expect(agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "openai:gpt-4o",
    })).rejects.toThrow(/Cross-provider routing is disabled/);
  });

  it("the lock lets profile routes pass (standing user authorization)", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      agentRouting: { allowCrossProvider: false },
    });
    const profile: AgentProfile = { ...defaultProfile(), model: "openai:gpt-4o" };
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "s1",
    });
    expect(snapshot.route?.providerId).toBe("openai");
    expect(snapshot.route?.modelSource).toBe("profile");
  });

  it("rejects cross-provider routes to providers without credentials, listing runnable ids", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessorFor({ enabled: [{ id: "anthropic" }] }),
    });
    await expect(agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "google:gemini-3.1-pro-preview",
    })).rejects.toThrow(/not configured with active credentials.*anthropic/s);
  });

  it("allowlist catalogs hard-reject unknown same-provider models with the available list", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "allowed-a",
      tools: [],
      routingSnapshot: accessorFor({
        customModels: [
          { id: "allowed-a", name: "A", providerId: "anthropic" },
          { id: "allowed-b", name: "B", providerId: "anthropic", tier: "fast" },
        ],
      }),
    });
    await expect(agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "invented-model",
    })).rejects.toThrow(/Unknown model "invented-model".*allowed-a.*allowed-b \(fast\)/s);
  });

  it("qualified same-provider ids go through same-provider validation, not the cross-provider path", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "allowed-a",
      tools: [],
      agentRouting: { allowCrossProvider: false }, // lock would reject if misrouted as cross-provider
      routingSnapshot: accessorFor({
        customModels: [{ id: "allowed-a", name: "A", providerId: "anthropic" }],
      }),
    });
    await expect(agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "anthropic:invented-model",
    })).rejects.toThrow(/Unknown model "invented-model"/);
  });

  it("non-authoritative catalogs allow unknown models (static builtin is not closed-world)", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessorFor(),
    });
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "claude-brand-new-model",
    });
    expect(snapshot.route?.model).toBe("claude-brand-new-model");
  });
});

// ---------------------------------------------------------------------------
// §6 detector

describe("defaulted fan-out detector (§6)", () => {
  function strongAgent(): Agent {
    return new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessorFor(),
    });
  }

  async function spawnDefaulted(agent: Agent, id: string, overrides: { model?: string; effort?: "low"; category?: string } = {}) {
    return agent.spawnSubAgent("scan", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: id,
      ...overrides,
    });
  }

  it("fires at 3 defaulted children on a strong parent, once per session", async () => {
    const agent = strongAgent();
    await spawnDefaulted(agent, "s1");
    await spawnDefaulted(agent, "s2");
    await spawnDefaulted(agent, "s3");
    const reminder = agent.consumePendingRoutingReminder();
    expect(reminder).toMatch(/3 children in this fan-out defaulted/);
    // Once per session: further defaulted spawns never re-fire.
    await spawnDefaulted(agent, "s4");
    await spawnDefaulted(agent, "s5");
    await spawnDefaulted(agent, "s6");
    expect(agent.consumePendingRoutingReminder()).toBeUndefined();
  });

  it("does not fire across counting windows (consume closes the window)", async () => {
    const agent = strongAgent();
    await spawnDefaulted(agent, "s1");
    await spawnDefaulted(agent, "s2");
    // Turn boundary: the hooks consume (and get nothing), resetting the count.
    expect(agent.consumePendingRoutingReminder()).toBeUndefined();
    await spawnDefaulted(agent, "s3");
    await spawnDefaulted(agent, "s4");
    expect(agent.consumePendingRoutingReminder()).toBeUndefined();
  });

  it("3 defaulted + 1 explicitly-routed child still fires (absolute count, no dilution)", async () => {
    const agent = strongAgent();
    await spawnDefaulted(agent, "s1");
    await spawnDefaulted(agent, "s2", { category: "quick" }); // routed — does not count, does not reset
    await spawnDefaulted(agent, "s3");
    await spawnDefaulted(agent, "s4");
    expect(agent.consumePendingRoutingReminder()).toMatch(/defaulted/);
  });

  it("counts children that differ only in effort (legacy inherited flag must not suppress)", async () => {
    const agent = strongAgent();
    await spawnDefaulted(agent, "s1", { effort: "low" });
    await spawnDefaulted(agent, "s2", { effort: "low" });
    await spawnDefaulted(agent, "s3", { effort: "low" });
    expect(agent.consumePendingRoutingReminder()).toMatch(/defaulted/);
  });

  it("explicit call-site naming the parent model does not count (deliberate choice)", async () => {
    const agent = strongAgent();
    await spawnDefaulted(agent, "s1", { model: "claude-fable-5" });
    await spawnDefaulted(agent, "s2", { model: "claude-fable-5" });
    await spawnDefaulted(agent, "s3", { model: "claude-fable-5" });
    expect(agent.consumePendingRoutingReminder()).toBeUndefined();
  });

  it("does not fire on a non-strong parent", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      tools: [],
      routingSnapshot: accessorFor(),
    });
    await spawnDefaulted(agent, "s1");
    await spawnDefaulted(agent, "s2");
    await spawnDefaulted(agent, "s3");
    expect(agent.consumePendingRoutingReminder()).toBeUndefined();
  });

  it("counts workflow agent() dispatches at dispatch time (resolved routes, not script text)", async () => {
    const agent = strongAgent();
    const { result } = await agent.runWorkflow("/tmp", {
      // Opts built dynamically — a source-text scan could not see these are
      // defaulted; dispatch-time counting does.
      script: `const opts = {}; await parallel([() => agent("a", opts), () => agent("b", opts), () => agent("c", opts)]); return "done";`,
      parentToolCallId: "wf-detector",
    });
    expect(result.ok).toBe(true);
    expect(agent.consumePendingRoutingReminder()).toMatch(/defaulted/);
  });
});

// ---------------------------------------------------------------------------
// §4 menu + §5 prompt composition

describe("routing menu prompt (§4)", () => {
  it("uses absolute wording only for an allowlist and conservative wording otherwise", () => {
    const allowlist = snapshotFor({
      customModels: [{ id: "allowed-a", name: "A", providerId: "anthropic", tier: "fast" }],
    });
    expect(buildModelRoutingPrompt(allowlist, { ...DEFAULT_AGENT_ROUTING }))
      .toContain("Choose only from this list");

    const fallback = snapshotFor();
    const prompt = buildModelRoutingPrompt(fallback, { ...DEFAULT_AGENT_ROUTING });
    expect(prompt).not.toContain("Choose only from this list");
    expect(prompt).toContain("list may lag the provider");
  });

  it("renders cross-provider availability from the lock state, both directions", () => {
    const snapshot = snapshotFor({ enabled: [{ id: "anthropic" }, { id: "openai" }, { id: "grok" }] });
    const open = buildModelRoutingPrompt(snapshot, { autoTier: true, allowCrossProvider: true });
    expect(open).toContain("available for providers with credentials: openai, grok");
    const locked = buildModelRoutingPrompt(snapshot, { autoTier: true, allowCrossProvider: false });
    expect(locked).toContain("disabled in this session");
  });

  it("shows post-resolution category bindings (quick -> fast model under a strong parent)", () => {
    const prompt = buildModelRoutingPrompt(snapshotFor(), { ...DEFAULT_AGENT_ROUTING });
    expect(prompt).toContain("quick → claude-haiku-4-5-20251001 + low");
    expect(prompt).toContain("review → inherit + high");
    expect(prompt).toContain("claude-fable-5 (strong)");
  });

  it("is gated on spawn_agent exactly like the delegation policy", () => {
    const menu = buildModelRoutingPrompt(snapshotFor(), { ...DEFAULT_AGENT_ROUTING });
    const withSpawn = composeSystemPrompt({ tools: ["read", "spawn_agent"], modelRoutingPrompt: menu });
    expect(withSpawn).toContain("## Subagent model routing");
    const withoutSpawn = composeSystemPrompt({ tools: ["read"], modelRoutingPrompt: menu });
    expect(withoutSpawn).not.toContain("## Subagent model routing");
  });

  it("delegation policy carries the routing paragraph", () => {
    const prompt = composeSystemPrompt({ tools: ["read", "spawn_agent"] });
    expect(prompt).toContain("Routing (model per child)");
    expect(prompt).toContain("do NOT downgrade it");
  });
});

// ---------------------------------------------------------------------------
// v3.6 — user-named model resolution, near-match correction, effort re-anchoring

describe("user-named model reminder (v3.6)", () => {
  const index: RoutableModelEntry[] = [
    { providerId: "openai", id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { providerId: "openai", id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { providerId: "zhipuai", id: "glm-5.2", name: "GLM-5.2" },
    { providerId: "zai", id: "glm-5.2", name: "GLM-5.2" },
    { providerId: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
  ];

  it("resolves the live-case phrasing to exact routable ids", () => {
    const reminder = userNamedModelReminder("使用GLM-5.2 和 gpt 5.6 sol 作为agent team, 看看这个项目在干嘛", index, true);
    expect(reminder).toContain("openai:gpt-5.6-sol");
    expect(reminder).toContain("zhipuai:glm-5.2");
    expect(reminder).toContain("also on: zai");
    expect(reminder).toContain("do not retype model ids from memory");
    // The truncated family id the parent invented must not appear as a target.
    expect(reminder).not.toContain("openai:gpt-5.6-terra");
  });

  it("stays silent when no configured model is named", () => {
    expect(userNamedModelReminder("帮我看看这个项目在干嘛", index, true)).toBeUndefined();
    expect(userNamedModelReminder("", index, true)).toBeUndefined();
  });

  it("stays silent for agents without spawn_agent and without an index", () => {
    expect(userNamedModelReminder("用 gpt 5.6 sol", index, false)).toBeUndefined();
    expect(userNamedModelReminder("用 gpt 5.6 sol", undefined, true)).toBeUndefined();
  });
});

describe("near-match correction at dispatch (v3.6)", () => {
  const openaiIndex: RoutableModelIndex = () => [
    { providerId: "openai", id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { providerId: "openai", id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { providerId: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    { providerId: "openai", id: "gpt-5.5", name: "gpt-5.5" },
  ];

  function grokAgent(routableModels?: RoutableModelIndex): Agent {
    return new Agent({
      provider: textProvider(),
      providerId: "grok",
      model: "grok-4.5",
      tools: [],
      routableModels,
    });
  }

  it("soft-rejects the live-case invented id with the correct candidates", async () => {
    const agent = grokAgent(openaiIndex);
    await expect(agent.spawnSubAgent("explore", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "openai:gpt-5.6",
    })).rejects.toThrow(/Did you mean: gpt-5\.6-luna, gpt-5\.6-sol, gpt-5\.6-terra/);
  });

  it("lets a genuinely novel cross-provider id through with a note (provider is the authority)", async () => {
    const agent = grokAgent(openaiIndex);
    const snapshot = await agent.spawnSubAgent("explore", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "openai:gpt-9-zeta",
    });
    expect(snapshot.route?.model).toBe("gpt-9-zeta");
  });

  it("degrades to the generic note when no index is wired", async () => {
    const agent = grokAgent(undefined);
    const snapshot = await agent.spawnSubAgent("explore", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      model: "openai:gpt-5.6",
    });
    expect(snapshot.route?.model).toBe("gpt-5.6");
  });
});

describe("category effort re-anchoring after model override (v3.6)", () => {
  it("uses the final model's default when the category level is unsupported (GLM live case)", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "grok",
      model: "grok-4.5",
      tools: [],
      routingSnapshot: accessorFor({ providerId: "grok", enabled: [{ id: "grok" }, { id: "zhipuai" }] }, {}),
    });
    const snapshot = await agent.spawnSubAgent("scan", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      category: "explore",              // thinkingLevel low, calibrated for the tier pick
      model: "zhipuai:glm-5.2",         // supports only high/max/off
    });
    // v3.5 behavior was "off" (silent thinking-kill); v3.6 re-anchors to the
    // model's own default: high.
    expect(snapshot.route?.thinkingLevel).toBe("high");
  });

  it("keeps the category level when the overriding model supports it", async () => {
    const agent = new Agent({
      provider: textProvider(),
      providerId: "anthropic",
      model: "claude-fable-5",
      tools: [],
      routingSnapshot: accessorFor(),
    });
    const snapshot = await agent.spawnSubAgent("scan", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "s1",
      category: "explore",              // thinkingLevel low
      model: "claude-opus-4-8",         // supports low
    });
    expect(snapshot.route?.thinkingLevel).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// §1.5 accessor freshness

describe("routing snapshot accessor (§1.5)", () => {
  it("caches by revision and rebuilds when the revision changes", () => {
    let revision = 0;
    let customModels: ModelInfo[] = [];
    const registry = {
      getConfigured: () => [{ id: "anthropic", name: "anthropic", baseURL: "x", apiKey: "k", enabled: true }],
      getEnabled: () => [{ id: "anthropic", name: "anthropic", baseURL: "x", apiKey: "k", enabled: true }],
      getModelConfig: () => ({ getCustomModels: () => customModels }),
      getCachedDiscoverySnapshot: () => undefined,
      getRoutingRevision: () => revision,
    } as unknown as ProviderRegistry;
    const accessor = createRoutingSnapshotAccessor(registry, () => ({}), () => ({ ...DEFAULT_AGENT_ROUTING }));

    const first = accessor(ANTHROPIC_PARENT);
    expect(first.membershipSource).toBe("fallback-union");
    // Same revision: cached object identity.
    expect(accessor(ANTHROPIC_PARENT)).toBe(first);

    // Mutation (e.g. discovery membership write) bumps the revision: the very
    // next read reflects the new world — no host refresh event needed.
    customModels = [{ id: "allowed-a", name: "A", providerId: "anthropic" }];
    revision = 1;
    const second = accessor(ANTHROPIC_PARENT);
    expect(second).not.toBe(first);
    expect(second.membershipSource).toBe("custom-allowlist");
  });

  it("rebuilds when the parent route changes", () => {
    const accessor = accessorFor();
    const strong = accessor(ANTHROPIC_PARENT);
    const fast = accessor({ providerId: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(strong.parent.tier).toBe("strong");
    expect(fast.parent.tier).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// PR-review fixes (Codex round on PR #61, design §11 v3.7)

describe("routing snapshot discovery-TTL invalidation", () => {
  it("caches while consumed discovery is fresh, rebuilds once it has expired", () => {
    const fresh = accessorFor({
      discovery: {
        models: [{ id: "m-1", name: "M1", providerId: "anthropic" }],
        source: "remote",
        complete: true,
        expiresAt: Date.now() + 60_000,
        identityKey: "k",
      } as any,
    });
    expect(fresh(ANTHROPIC_PARENT)).toBe(fresh(ANTHROPIC_PARENT));

    // TTL expiry bumps no revision; the accessor must rebuild regardless.
    const expired = accessorFor({
      discovery: {
        models: [{ id: "m-1", name: "M1", providerId: "anthropic" }],
        source: "remote",
        complete: true,
        expiresAt: Date.now() - 1,
        identityKey: "k",
      } as any,
    });
    expect(expired(ANTHROPIC_PARENT)).not.toBe(expired(ANTHROPIC_PARENT));
  });
});

describe("nearModelMatches direction modes", () => {
  const catalog: RoutableModelEntry[] = [
    { providerId: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ];

  it("suggest mode matches prefixes in both directions", () => {
    expect(nearModelMatches("gpt-5.6", catalog)).toEqual(["gpt-5.6-sol"]);
    expect(nearModelMatches("gpt-5.6-sol-20260701", catalog)).toEqual(["gpt-5.6-sol"]);
  });

  it("truncation mode never flags an input that extends a catalog id", () => {
    // A dated/longer variant is likelier a newly released id than a typo;
    // the hard-reject path must let the provider validate it.
    expect(nearModelMatches("gpt-5.6", catalog, { mode: "truncation" })).toEqual(["gpt-5.6-sol"]);
    expect(nearModelMatches("gpt-5.6-sol-20260701", catalog, { mode: "truncation" })).toEqual([]);
  });
});

describe("routing prompt truncation wording", () => {
  it("a truncated allowlist never claims arbitrary ids are valid", () => {
    const customModels = Array.from({ length: 15 }, (_, i) => ({
      id: `allowed-${String(i).padStart(2, "0")}`,
      name: `Allowed ${i}`,
      providerId: "anthropic",
    }));
    const prompt = buildModelRoutingPrompt(snapshotFor({ customModels }), { ...DEFAULT_AGENT_ROUTING });
    expect(prompt).toContain("in the configured allowlist (not shown); ids outside the allowlist are rejected");
    expect(prompt).toContain("Choose only from the configured allowlist");
    expect(prompt).not.toContain("any explicit id from this provider is valid");
  });

  it("a truncated open catalog keeps the any-explicit-id wording", () => {
    const discovery = {
      models: Array.from({ length: 15 }, (_, i) => ({ id: `disc-${String(i).padStart(2, "0")}`, name: `D${i}`, providerId: "anthropic" })),
      source: "remote",
      complete: false,
      expiresAt: Date.now() + 60_000,
      identityKey: "k",
    } as any;
    const prompt = buildModelRoutingPrompt(snapshotFor({ discovery }), { ...DEFAULT_AGENT_ROUTING });
    if (prompt.includes("… and")) {
      expect(prompt).toContain("any explicit id from this provider is valid");
    }
    expect(prompt).not.toContain("Choose only from the configured allowlist");
  });
});
