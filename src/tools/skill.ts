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
    description: "Load a named skill on demand. Use this when a task clearly matches one of the available skills.",
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
        const available = registry.summaries().map((item) => item.name).join(", ");
        return {
          content: available
            ? `Error: Unknown skill "${name}". Available skills: ${available}`
            : `Error: Unknown skill "${name}". No skills are currently available.`,
          isError: true,
        };
      }

      return { content: formatLoadedSkill(skill) };
    },
  };
}
