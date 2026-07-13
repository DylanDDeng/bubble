/**
 * Subagent model-routing menu for the parent agent's system prompt
 * (docs/model-routing-design.md §4).
 *
 * Wording rules: the prompt must never promise more enforcement than the
 * runtime delivers at any later moment. Absolute "choose only from this
 * list" wording is used only for a models.json allowlist (the one catalog
 * that cannot silently expire); every other membership source gets the
 * conservative lag disclaimer, matching §7.1's warn-and-allow validation.
 * Gated on spawn_agent alongside the delegation policy — children never
 * see it.
 */

import type { AgentRoutingConfig, RoutingSnapshot } from "../agent/routing-catalog.js";

const MENU_MODEL_LIMIT = 12;

export function buildModelRoutingPrompt(
  snapshot: RoutingSnapshot,
  agentRouting: AgentRoutingConfig,
): string {
  const lines: string[] = ["## Subagent model routing"];

  const parentTier = snapshot.parent.tier ? ` (${snapshot.parent.tier} tier)` : "";
  lines.push(`Parent model: ${snapshot.parent.providerId} ${snapshot.parent.model}${parentTier}.`);

  const categories = snapshot.resolvedCategories
    .map((category) => {
      const effort = category.thinkingLevel ? ` + ${category.thinkingLevel}` : "";
      return `${category.name} → ${category.model}${effort}`;
    })
    .join(" · ");
  if (categories) {
    lines.push("Categories (category → what a spawn actually gets):");
    lines.push(`  ${categories}`);
  }

  // Tiered models first, then untiered; cap with an explicit remainder note
  // so truncation never reads as "nothing else exists".
  const ordered = [...snapshot.models].sort((a, b) => {
    const aTiered = a.tier ? 0 : 1;
    const bTiered = b.tier ? 0 : 1;
    return aTiered - bTiered;
  });
  const shown = ordered.slice(0, MENU_MODEL_LIMIT);
  const remainder = ordered.length - shown.length;
  const modelList = shown
    .map((model) => (model.tier ? `${model.id} (${model.tier})` : model.id))
    .join(" · ");
  if (modelList) {
    lines.push("Models on this provider, usable via per-call `model`:");
    lines.push(`  ${modelList}`);
    if (remainder > 0) {
      lines.push(`  … and ${remainder} more; any explicit id from this provider is valid.`);
    }
  }

  if (snapshot.authoritative) {
    lines.push("Choose only from this list; do not invent model ids.");
  } else {
    lines.push("(list may lag the provider; explicit ids not listed are allowed)");
  }

  if (agentRouting.allowCrossProvider) {
    const runnable = snapshot.runnableProviderIds
      .filter((id) => id !== snapshot.parent.providerId);
    if (runnable.length > 0) {
      lines.push(
        `Cross-provider routing (provider:model) is available for providers with credentials: ${runnable.join(", ")}.`,
      );
    } else {
      lines.push("Cross-provider routing (provider:model): no other provider has credentials in this session.");
    }
  } else {
    lines.push("Cross-provider routing (provider:model) is disabled in this session.");
  }

  return lines.join("\n");
}
