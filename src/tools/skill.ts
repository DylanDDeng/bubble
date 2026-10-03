import type { SkillRecord } from "../skills/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

export function formatLoadedSkill(skill: SkillRecord): string {
  const resources = [
    ...skill.resources.references,
    ...skill.resources.scripts,
    ...skill.resources.assets,
  ];

  const sections = [
    `Skill: ${skill.meta.name}`,
    `Description: ${skill.meta.description}`,
    `Base directory: ${skill.rootDir}`,
    "",
    skill.content,
  ];

  if (resources.length > 0) {
    sections.push("", "Resources:", ...resources.map((resource) => `- ${resource}`));
  }

  sections.push("", "Relative paths mentioned in this skill are resolved from the base directory above.");

  return sections.join("\n");
}

export function createSkillTool(registry: SkillRegistry): ToolRegistryEntry {
  return {
    name: "skill",
    readOnly: true,
    effect: "read",
    description: "Load a skill by its exact name, as listed in the Skills section of the system prompt. Returns the skill's instructions; follow them for the task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact skill name to load" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return { content: "Error: skill name is required", isError: true };
      }

      const skill = registry.get(name);
      if (!skill) {
        const close = closestSkillNames(name, registry.summaries().map((s) => s.name));
        return {
          content:
            `Error: Unknown skill "${name}".` +
            (close.length ? ` Did you mean: ${close.join(", ")}?` : "") +
            " Use the exact name from the Skills section.",
          isError: true,
        };
      }

      return { content: formatLoadedSkill(skill) };
    },
  };
}

/** Up to three known names closest to a mistyped one (substring first, then edit distance). */
export function closestSkillNames(name: string, names: string[]): string[] {
  const target = name.toLowerCase();
  const scored = names.map((candidate) => {
    const lower = candidate.toLowerCase();
    // Substring matches only for real fragments; a 1–2 letter typo would match everything.
    const contains = target.length >= 3 && (lower.includes(target) || target.includes(lower));
    return { candidate, score: contains ? 0 : editDistance(target, lower) };
  });
  const limit = Math.max(2, Math.floor(target.length / 3));
  return scored
    .filter((s) => s.score <= limit)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((s) => s.candidate);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
