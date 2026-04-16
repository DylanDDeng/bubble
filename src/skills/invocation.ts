import type { SkillRegistry } from "./registry.js";
import type { SkillRecord } from "./types.js";

export interface SkillInvocation {
  skill: SkillRecord;
  task: string;
  actualPrompt: string;
}

export function parseSkillInvocation(input: string, registry: SkillRegistry): SkillInvocation | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) return undefined;

  if (withoutSlash.startsWith("skill ")) {
    const rest = withoutSlash.slice("skill ".length).trim();
    const firstSpace = rest.indexOf(" ");
    if (firstSpace === -1) return undefined;
    const skillName = rest.slice(0, firstSpace).trim();
    const task = rest.slice(firstSpace + 1).trim();
    if (!skillName || !task) return undefined;
    const skill = registry.get(skillName);
    if (!skill) return undefined;
    return {
      skill,
      task,
      actualPrompt: buildSkillExecutionPrompt(skill, task),
    };
  }

  const firstSpace = withoutSlash.indexOf(" ");
  if (firstSpace === -1) return undefined;
  const skillName = withoutSlash.slice(0, firstSpace).trim();
  const task = withoutSlash.slice(firstSpace + 1).trim();
  if (!skillName || !task) return undefined;
  const skill = registry.get(skillName);
  if (!skill) return undefined;
  return {
    skill,
    task,
    actualPrompt: buildSkillExecutionPrompt(skill, task),
  };
}

function buildSkillExecutionPrompt(skill: SkillRecord, task: string): string {
  return [
    `Use the skill tool to load the "${skill.meta.name}" skill before responding.`,
    `The task clearly matches that skill.`,
    `Do not simply restate the skill contents; use the loaded instructions to complete the task.`,
    "",
    "User request:",
    task,
  ].join("\n");
}

