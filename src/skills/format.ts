import type { SkillSummary } from "./types.js";

const MAX_SKILL_DESC_CHARS = 200;
const SKILLS_BUDGET_CHARS = 6000;

const SOURCE_PRIORITY: Record<NonNullable<SkillSummary["source"]>, number> = {
  project: 0,
  configured: 1,
  user: 2,
};

export function formatSkillsPrompt(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const sorted = [...skills].sort((a, b) => {
    const ap = SOURCE_PRIORITY[a.source ?? "user"] ?? 3;
    const bp = SOURCE_PRIORITY[b.source ?? "user"] ?? 3;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });

  const header = [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill system when a task clearly matches a skill description.",
    "Available skills:",
  ];

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const skill of sorted) {
    const line = formatSkillLine(skill);
    if (used + line.length + 1 > SKILLS_BUDGET_CHARS) {
      dropped = sorted.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (dropped > 0) {
    lines.push(`- ... and ${dropped} more skills (use /skills to list all)`);
  }

  return [...header, ...lines].join("\n");
}

function formatSkillLine(skill: SkillSummary): string {
  const tagSuffix = skill.tags && skill.tags.length > 0 ? ` [tags: ${skill.tags.join(", ")}]` : "";
  const rawDesc = skill.description ?? "";
  const desc = rawDesc.length > MAX_SKILL_DESC_CHARS
    ? rawDesc.slice(0, MAX_SKILL_DESC_CHARS - 1) + "…"
    : rawDesc;
  return `- ${skill.name}: ${desc}${tagSuffix}`;
}
