import type { SkillRegistry } from "../skills/registry.js";
import type { SkillSummary } from "../skills/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 25;

const SOURCE_PRIORITY: Record<NonNullable<SkillSummary["source"]>, number> = {
  project: 0,
  configured: 1,
  user: 2,
};

interface SkillSearchMatch {
  skill: SkillSummary;
  score: number;
}

export function createSkillSearchTool(registry: SkillRegistry): ToolRegistryEntry {
  return {
    name: "skill_search",
    readOnly: true,
    effect: "read",
    description:
      "Search available skills by name, description, tags, and source. Use this before loading a skill when a task may match a specialized workflow.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms describing the desired skill or workflow.",
        },
        max_results: {
          type: "number",
          description: `Maximum number of matches to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const maxResults = typeof args.max_results === "number" && args.max_results > 0
        ? Math.min(Math.floor(args.max_results), MAX_RESULTS)
        : DEFAULT_MAX_RESULTS;
      const skills = registry.summaries();

      if (skills.length === 0) {
        return { content: "No skills are currently available." };
      }

      const matches = searchSkillSummaries(skills, query).slice(0, maxResults);
      if (matches.length === 0) {
        return {
          content: `No skills matched "${query}". Try broader terms or use /skills to browse all skills manually.`,
        };
      }

      return {
        content: formatSkillSearchResults(matches, skills.length, query),
      };
    },
  };
}

export function searchSkillSummaries(skills: SkillSummary[], query: string): SkillSearchMatch[] {
  const terms = normalizeTerms(query);
  const scored: SkillSearchMatch[] = [];
  for (const skill of skills) {
    const score = scoreSkill(skill, terms, query);
    if (score > 0 || terms.length === 0) {
      scored.push({ skill, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = SOURCE_PRIORITY[a.skill.source ?? "user"] ?? 3;
    const bp = SOURCE_PRIORITY[b.skill.source ?? "user"] ?? 3;
    if (ap !== bp) return ap - bp;
    return a.skill.name.localeCompare(b.skill.name);
  });
  return scored;
}

function scoreSkill(skill: SkillSummary, terms: string[], rawQuery: string): number {
  const name = skill.name.toLowerCase();
  const desc = (skill.description ?? "").toLowerCase();
  const tags = (skill.tags ?? []).map((tag) => tag.toLowerCase());
  const source = skill.source ?? "user";
  const sourceBonus = source === "project" ? 4 : source === "configured" ? 2 : 0;
  const query = rawQuery.trim().toLowerCase();

  if (terms.length === 0) return 1 + sourceBonus;

  let score = 0;
  if (name === query) score += 80;
  if (name.includes(query) && query.length > 0) score += 30;

  for (const term of terms) {
    if (name === term) score += 30;
    else if (name.includes(term)) score += 12;
    if (tags.some((tag) => tag === term)) score += 10;
    else if (tags.some((tag) => tag.includes(term))) score += 6;
    if (desc.includes(term)) score += 3;
    if (source.includes(term)) score += 2;
  }
  return score > 0 ? score + sourceBonus : 0;
}

function normalizeTerms(query: string): string[] {
  const rawTerms = query
    .toLowerCase()
    .split(/[^a-z0-9_\-\u3000-\u9fff]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
  const terms = new Set<string>();
  for (const term of rawTerms) {
    terms.add(term);
    const chars = Array.from(term);
    if (chars.some(isCjkChar) && chars.length > 2) {
      for (let i = 0; i < chars.length - 1; i++) {
        terms.add(`${chars[i]}${chars[i + 1]}`);
      }
    }
  }
  return [...terms];
}

function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x3000 && code <= 0x9fff;
}

function formatSkillSearchResults(matches: SkillSearchMatch[], total: number, query: string): string {
  const lines = [
    query ? `Skill search results for "${query}" (${matches.length} of ${total}):` : `Available skills (${matches.length} of ${total}):`,
  ];
  for (const { skill } of matches) {
    const tags = skill.tags && skill.tags.length > 0 ? ` [tags: ${skill.tags.join(", ")}]` : "";
    const source = skill.source ? ` (${skill.source})` : "";
    lines.push(`- ${skill.name}${source}: ${skill.description}${tags}`);
  }
  lines.push("");
  lines.push("Call skill with the exact name to load a selected skill.");
  return lines.join("\n");
}
