/**
 * Subagent model routing (design §3-§7).
 *
 * Extracted from Agent so the routing decision chain and the routing prompt
 * rendering live in one place: before this, the decision side sat next to the
 * subagent dispatch code while `buildModelRoutingPromptSection` /
 * `renderModelRoutingPromptFor` sat 2,000 lines away at the top of the class,
 * with both halves reading the same `agentRouting` / `routingSnapshot` fields.
 *
 * The parent route is supplied as a thunk, never a snapshot: `/model` mutates
 * the parent's provider, model and thinking level mid-session, and children
 * spawned afterwards must inherit the CURRENT values.
 */
import { mergeAgentCategories, resolveModelRoute, resolveSubagentRoute, type AgentCategoriesConfig, type ResolvedSubagentRoute } from "../categories.js";
import { nearModelMatches, tierContextFromSnapshot, type AgentRoutingConfig, type RoutableModelEntry, type RoutableModelIndex, type RoutingSnapshot, type RoutingSnapshotAccessor } from "../routing-catalog.js";
import { buildModelRoutingPrompt } from "../../prompt/routing.js";
import { getBuiltinModel } from "../../model-catalog.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeInheritedThinkingLevel, normalizeThinkingLevel } from "../../variant/variant-resolver.js";
import type { AgentProfile } from "../profiles.js";
import type { ThinkingLevel } from "../../types.js";

/** Dispatches with an undecided model before the fan-out reminder fires (§6). */
const ROUTING_REMINDER_THRESHOLD = 3;

export interface ParentRoute {
  providerId: string;
  /** The API-facing model id — already stripped of any "provider:" prefix. */
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface SubagentRouterDeps {
  /**
   * Live parent route. MUST read through to the agent on every call — `/model`
   * reassigns provider/model/thinking mid-session (see slash-commands), and a
   * captured snapshot would route children to the pre-switch model.
   */
  parentRoute(): ParentRoute;
  categories: AgentCategoriesConfig;
  routing: AgentRoutingConfig;
  snapshot?: RoutingSnapshotAccessor;
  routableModels?: RoutableModelIndex;
}

export class SubagentRouter {
  private readonly deps: SubagentRouterDeps;
  private reminderFired = false;
  private defaultedStreak = 0;
  private pendingReminder?: string;

  constructor(deps: SubagentRouterDeps) {
    this.deps = deps;
  }

  /** Live snapshot for the CURRENT parent route; undefined when no accessor is wired. */
  currentSnapshot(): RoutingSnapshot | undefined {
    if (!this.deps.snapshot) return undefined;
    const parent = this.deps.parentRoute();
    try {
      return this.deps.snapshot({ providerId: parent.providerId, model: parent.model });
    } catch {
      // Catalog data is an enhancement, never a spawn blocker.
      return undefined;
    }
  }

  resolve(
    profile: AgentProfile,
    category: string | undefined,
    override?: { model?: string; effort?: ThinkingLevel },
  ): ResolvedSubagentRoute {
    const parentRoute = this.deps.parentRoute();
    const snapshot = this.currentSnapshot();
    const resolved = resolveSubagentRoute(
      category ?? profile.category,
      { ...parentRoute },
      this.deps.categories,
      snapshot ? tierContextFromSnapshot(snapshot, this.deps.routing) : undefined,
    );
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    let route = resolved.route;
    // modelSource is assigned while applying the chain (design §3.4): an
    // explicit layer naming the parent's own model is indistinguishable from
    // inherit by final-value comparison, yet carries different authority.
    let modelSource: import("../categories.js").RouteModelSource =
      route.categoryModelSource ?? "inherit";
    if (profile.model && profile.model !== "inherit") {
      const model = resolveModelRoute(profile.model, parentRoute.providerId);
      if (model.model !== "inherit") {
        route = { ...route, providerId: model.providerId, model: model.model, inherited: false };
        modelSource = "profile";
      }
    }
    // Call-site override beats profile and category. Bare names resolve
    // against the PARENT provider per the tool contract (design §3.5) — not
    // against a provider that category/profile may already have switched.
    if (override?.model) {
      const model = resolveModelRoute(override.model, parentRoute.providerId);
      if (model.model !== "inherit") {
        route = { ...route, providerId: model.providerId, model: model.model, inherited: false };
        modelSource = "callsite";
      }
    }
    const supportedLevels = getAvailableThinkingLevels(route.providerId, route.model);
    const modelMetadata = getBuiltinModel(route.providerId, route.model);
    const hasTrustedEffortMetadata = !!modelMetadata
      && modelMetadata.reasoningLevels.some((level) => level !== "off");
    if (override?.effort) {
      // A call-site effort is explicit user/model intent: preserve the existing
      // value for legacy/unknown models, and downward-clamp only when the
      // catalog declares real effort capabilities (for example Luna ultra -> max).
      route = {
        ...route,
        thinkingLevel: hasTrustedEffortMetadata
          ? normalizeThinkingLevel(override.effort, supportedLevels)
          : override.effort,
        inherited: false,
      };
    } else if (hasTrustedEffortMetadata) {
      const categoryThinkingLevel = route.category
        ? mergeAgentCategories(this.deps.categories)[route.category]?.thinkingLevel
        : undefined;
      // A category's thinkingLevel is calibrated for the model the CATEGORY
      // resolved. When a later layer (profile/call-site) replaced the model,
      // that level is no longer explicit intent for the final model: keep it
      // only if supported, else use the final model's own default — never
      // downward-clamp a thinking-default model to "off" (v3.6; live case:
      // explore's "low" + call-site glm-5.2 [high/max/off] silently landed
      // on "off").
      const modelReplacedAfterCategory = modelSource === "profile" || modelSource === "callsite";
      route = {
        ...route,
        thinkingLevel: categoryThinkingLevel
          ? (modelReplacedAfterCategory && !supportedLevels.includes(route.thinkingLevel)
              ? getDefaultThinkingLevel(route.providerId, route.model)
              : normalizeThinkingLevel(route.thinkingLevel, supportedLevels))
          : normalizeInheritedThinkingLevel(route.providerId, route.model, route.thinkingLevel),
      };
    }
    return {
      ...route,
      modelSource,
      modelInherited: route.providerId === parentRoute.providerId && route.model === parentRoute.model,
    };
  }

  /**
   * Early route validation at dispatch time (design §7). Throws with an
   * actionable message so the model self-corrects in the same turn. The
   * cross-provider lock (§7.2.1) is snapshot-independent; catalog checks
   * degrade silently when no snapshot is available (§7.0).
   */
  validateForDispatch(route: ResolvedSubagentRoute): string | undefined {
    const parentProviderId = this.deps.parentRoute().providerId;
    const snapshot = this.currentSnapshot();
    const crossProvider = !!route.providerId && route.providerId !== parentProviderId;

    if (crossProvider) {
      // §7.2.1 — the lock. Profile/user-category routes are standing user
      // authorization and always pass; only call-site routes are lockable.
      if (!this.deps.routing.allowCrossProvider && route.modelSource === "callsite") {
        throw new Error(
          "Cross-provider routing is disabled in this session's config (agentRouting.allowCrossProvider). "
          + "Use a model from the parent provider, or ask the user to unlock cross-provider routing.",
        );
      }
      // §7.2.2 — credentials, when a snapshot is available.
      if (snapshot && !snapshot.runnableProviderIds.includes(route.providerId)) {
        throw new Error(
          `Provider "${route.providerId}" is not configured with active credentials. `
          + `Available: ${snapshot.runnableProviderIds.join(", ") || "(none)"}.`,
        );
      }
      // §7.2.3 amended (v3.6): the provider stays the authority — no hard
      // catalog rejection — but a near-match against the target provider's
      // local catalog is positive evidence of a mistyped id (a Grok parent
      // invented "openai:gpt-5.6" for gpt-5.6-sol), so soft-reject with the
      // correction and let the model fix it this turn. Genuinely unknown ids
      // (no near candidates) still pass through with a note.
      const targetCatalog = this.deps.routableModels?.()
        .filter((entry) => entry.providerId === route.providerId) ?? [];
      if (targetCatalog.length > 0 && !targetCatalog.some((entry) => entry.id === route.model)) {
        const near = nearModelMatches(route.model, targetCatalog, { mode: "truncation" });
        if (near.length > 0) {
          throw new Error(
            `Unknown model "${route.model}" for provider "${route.providerId}". Did you mean: ${near.join(", ")}?`,
          );
        }
        return `model ${route.providerId}:${route.model} is not in the local catalog; the provider validates it`;
      }
      return `model ${route.providerId}:${route.model} is not locally verifiable; the provider validates it`;
    }

    // §7.1 — same-provider unknown model, resolved-provider based (never
    // input-syntax based; qualified same-provider ids land here too).
    if (snapshot && route.modelSource === "callsite") {
      const known = snapshot.models.some((model) => model.id === route.model);
      if (!known) {
        if (snapshot.authoritative) {
          const available = snapshot.models
            .map((model) => (model.tier ? `${model.id} (${model.tier})` : model.id))
            .join(", ");
          throw new Error(
            `Unknown model "${route.model}" for provider "${parentProviderId}". Available: ${available}.`,
          );
        }
        const near = nearModelMatches(
          route.model,
          snapshot.models.map((model): RoutableModelEntry => ({ providerId: parentProviderId, id: model.id, name: model.name })),
        );
        return near.length > 0
          ? `model id "${route.model}" is unrecognized locally (did you mean: ${near.join(", ")}?); the provider validates it`
          : `model id "${route.model}" is unrecognized locally; the provider validates it`;
      }
    }
    return undefined;
  }

  /** Routable catalog across runnable providers (design v3.6); undefined when unwired. */
  listRoutableModels(): RoutableModelEntry[] | undefined {
    try {
      return this.deps.routableModels?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Decision-point detector (design §6): counts dispatches whose model was
   * decided by NO routing layer (modelSource "inherit") under a strong-tier
   * parent. Fires once per session at the Nth qualifying dispatch; the
   * reminder rides the same channel as the lifecycle reminder.
   */
  noteDispatch(route: ResolvedSubagentRoute): void {
    if (this.reminderFired) return;
    if (route.modelSource !== "inherit") return;
    const snapshot = this.currentSnapshot();
    if (snapshot?.parent.tier !== "strong") return;
    this.defaultedStreak++;
    if (this.defaultedStreak >= ROUTING_REMINDER_THRESHOLD) {
      this.reminderFired = true;
      this.pendingReminder = [
        `Routing note: ${this.defaultedStreak} children in this fan-out defaulted to the parent's`,
        "strong-tier model (no model/category given). If any of these tasks are mechanical",
        "(scan / summarize / search / extract), route them with category \"quick\"/\"explore\" or a",
        "fast-tier model next time. If they genuinely need this model, ignore this note.",
      ].join(" ");
    }
  }

  /** Consumed by the turn hooks; also closes the counting window (§6). */
  consumePendingReminder(): string | undefined {
    const reminder = this.pendingReminder;
    this.pendingReminder = undefined;
    if (!this.reminderFired) this.defaultedStreak = 0;
    return reminder;
  }

  /** Current routing menu (design §4); undefined when no accessor is wired. */
  promptSection(): string | undefined {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return undefined;
    return buildModelRoutingPrompt(snapshot, this.deps.routing);
  }

  /**
   * Routing menu rendered for a prospective parent route — used by model-
   * switch transactions to build the NEXT prompt before mutating the agent
   * (design §1.5).
   */
  promptSectionFor(parent: { providerId: string; model: string }): string | undefined {
    if (!this.deps.snapshot) return undefined;
    try {
      return buildModelRoutingPrompt(this.deps.snapshot(parent), this.deps.routing);
    } catch {
      return undefined;
    }
  }
}
