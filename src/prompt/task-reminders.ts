import { normalizeModelToken, type RoutableModelEntry } from "../agent/routing-catalog.js";

/**
 * User-named model resolution (model-routing design v3.6): when the user's
 * message names a model that exists in the routable catalog, hand the main
 * agent the EXACT provider:model id at the decision point. The catalog is a
 * closed set, so matching is deterministic — the model must never retype an
 * id from priors when the harness can resolve it ("gpt 5.6 sol" ->
 * openai:gpt-5.6-sol; a Grok-4.5 parent invented "openai:gpt-5.6" without
 * this, 2026-07-12 live case). Silent on no match: zero standing noise.
 */
export function userNamedModelReminder(
  input: string | import("../types.js").ContentPart[],
  routableModels: RoutableModelEntry[] | undefined,
  canSpawn: boolean,
): string | undefined {
  if (!canSpawn || !routableModels || routableModels.length === 0) return undefined;
  const text = typeof input === "string"
    ? input
    : input.map((part) => ("text" in part ? String(part.text ?? "") : "")).join(" ");
  if (!text.trim()) return undefined;
  const normalizedInput = normalizeModelToken(text);

  // Group by model id so multi-provider models (glm-5.2 on four providers)
  // produce one line listing the routable providers.
  const hitsByModel = new Map<string, { entry: RoutableModelEntry; providerIds: string[] }>();
  for (const entry of routableModels) {
    const keys = [normalizeModelToken(entry.id), normalizeModelToken(entry.name)];
    // Short keys ("o1", "glm") would match prose; require some substance.
    if (!keys.some((key) => key.length >= 5 && normalizedInput.includes(key))) continue;
    const hit = hitsByModel.get(entry.id);
    if (hit) {
      if (!hit.providerIds.includes(entry.providerId)) hit.providerIds.push(entry.providerId);
    } else {
      hitsByModel.set(entry.id, { entry, providerIds: [entry.providerId] });
    }
  }
  if (hitsByModel.size === 0) return undefined;

  const lines = [...hitsByModel.values()].slice(0, 6).map(({ entry, providerIds }) => {
    const primary = `${providerIds[0]}:${entry.id}`;
    const alternates = providerIds.length > 1 ? ` (also on: ${providerIds.slice(1).join(", ")})` : "";
    return `- "${entry.name}" → ${primary}${alternates}`;
  });
  return [
    "The user's message names these configured models. Exact routable ids:",
    ...lines,
    "Use these exact ids in spawn_agent / run_workflow `model` params; do not retype model ids from memory.",
  ].join("\n");
}

const ORCHESTRATION_REQUEST =
  /\b(?:workflows?|orchestrat\w*|agent[ -]?teams?|fan[ -]?out)\b|工作流|编排|(?:智能体|代理|agent)\s*(?:团队|小队)/i;

export function orchestrationRequestReminder(
  input: string | import("../types.js").ContentPart[],
  canRunWorkflow: boolean,
): string | undefined {
  if (!canRunWorkflow) return undefined;
  const text = typeof input === "string"
    ? input
    : input.map((part) => ("text" in part ? String(part.text ?? "") : "")).join(" ");
  if (!ORCHESTRATION_REQUEST.test(text)) return undefined;
  return [
    "- This message explicitly asks for a coordinated multi-agent run (a workflow / orchestration / agent team).",
    "Honor it with ONE run_workflow call whose script covers the whole fan-out.",
    "Do not substitute parallel spawn_agent calls this turn — the user named the mechanism.",
  ].join(" ");
}
