import type { TaskType } from "../agent/task-classifier.js";
import { normalizeModelToken, type RoutableModelEntry } from "../agent/routing-catalog.js";
import { wrapInSystemReminder } from "./reminders.js";

export interface TaskReminderOptions {
  /** Whether this agent has the delegation tools (parent agents only). */
  canDelegate?: boolean;
}

/**
 * Delegation nudge for exploration-shaped tasks: injected at the decision
 * point (start of turn), where it carries far more weight for weakly
 * delegating models than the session-start system prompt. Task-type gating
 * keeps it away from ordinary implementation/debugging turns, so it cannot
 * amplify over-delegation.
 */
const DELEGATION_NUDGE =
  "- If answering needs scanning many files and only the conclusion matters, delegate to a background subagent (spawn_agent); when it is the same read-only question over several independent items, fan out with a run_workflow script.";

export function reminderForTaskType(taskType: TaskType, options: TaskReminderOptions = {}): string | undefined {
  switch (taskType) {
    case "debugging":
      return wrapInSystemReminder(`
Debugging workflow:
- Reproduce or identify the failing boundary before editing.
- Trace input, transformation, and output paths.
- Prefer fixing the mechanism over raising thresholds or adding superficial fallbacks.
- Verify the specific failure path after the change.
`);
    case "implementation":
      return wrapInSystemReminder(`
Implementation workflow:
- Do not stop at a proposal when the user asked for a change.
- Inspect the relevant files first, then make the smallest coherent edit.
- Keep unrelated files and behavior out of scope.
- Run a narrow verification command or explain why it cannot be run.
`);
    case "code_review":
      return wrapInSystemReminder(`
Code review workflow:
- Lead with concrete findings, ordered by severity.
- Reference file paths and line numbers when possible.
- Prioritize bugs, regressions, missing tests, security, and user-visible risk.
- Keep summaries secondary to findings.
`);
    case "code_explanation":
      return wrapInSystemReminder(`
Code explanation workflow:
- Answer the direct question first.
- Ground claims in concrete files, functions, and call paths.
- Distinguish current source evidence from inference.
- Avoid proposing changes unless the user asks for them.
`);
    case "repo_orientation":
      return wrapInSystemReminder(`
Repository orientation workflow:
- Start with the repo purpose and main execution paths.
- Inspect README/package metadata plus core runtime files before summarizing.
- Keep the first pass read-only unless the user asks for changes or runtime verification.
${options.canDelegate ? `${DELEGATION_NUDGE}\n` : ""}`);
    case "product_discussion":
      return wrapInSystemReminder(`
Product discussion workflow:
- Clarify the product goal, user workflow, and tradeoffs before suggesting implementation.
- Give direct product judgment when the user asks for direction.
- Avoid drifting into code changes unless the user explicitly asks to execute.
`);
    case "security_investigation":
    case "code_search":
    case "general":
    default:
      return undefined;
  }
}


/**
 * Deterministic detector for an explicit user request for a coordinated
 * multi-agent run. Three rounds of prompt wording lost to the model's
 * "agent team = parallel spawns" prior in live tests (opus-4.8, 2026-07-06);
 * per the task-reminder principle above, a reminder injected at the decision
 * turn is the lever that actually works — the harness remembers so the model
 * does not have to.
 */
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
