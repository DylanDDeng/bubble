import { formatSkillsPrompt } from "../skills/format.js";
import type { SkillSummary } from "../skills/types.js";

export function buildSkillsPrompt(skills: SkillSummary[] = []): string {
  return formatSkillsPrompt(skills);
}

