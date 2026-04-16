import type { SkillSummary } from "./types.js";

export function formatSkillsPrompt(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill system when a task clearly matches a skill description.",
    "Available skills:",
    ...skills.map((skill) => {
      const tagSuffix = skill.tags && skill.tags.length > 0 ? ` [tags: ${skill.tags.join(", ")}]` : "";
      return `- ${skill.name}: ${skill.description}${tagSuffix}`;
    }),
  ];

  return lines.join("\n");
}

