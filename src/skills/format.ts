import type { SkillSummary } from "./types.js";

/** Default size of the always-present skill catalog (the listed lines, not the header). */
export const SKILL_CATALOG_CHARS = 12_000;
/** Each description is cut to this length; it only has to tell the model when to load. */
export const SKILL_CATALOG_DESC_CHARS = 120;
export const SKILL_CATALOG_HEADING = "## Skills";
/** First line under the heading; together they mark the catalog unambiguously. */
export const SKILL_CATALOG_INTRO =
  "Skills are task-specific instructions loaded on demand. When a task matches a skill below, call `skill` with its exact name before starting, then follow it. Load only what clearly applies.";

const SOURCE_PRIORITY: Record<NonNullable<SkillSummary["source"]>, number> = {
  project: 0,
  configured: 1,
  user: 2,
};

export interface SkillCatalogOptions {
  /** Budget for the listed lines; 0 turns the catalog off. */
  budgetChars?: number;
  /** skill_search is available, so the overflow line can point to it. */
  searchable?: boolean;
}

export interface SkillCatalog {
  /** The system-prompt section, or "" when there is nothing to list. */
  text: string;
  listed: number;
  unlisted: number;
  /** Characters used by the listed lines, against budgetChars. */
  chars: number;
  budgetChars: number;
}

/**
 * The always-present skill catalog: name and a one-line description per skill,
 * so the model knows what exists and loads a body with `skill` only when it
 * applies. Ordering is deterministic (source, then name) so the system prompt
 * stays byte-identical, and cacheable, while the skill set is unchanged.
 */
export function buildSkillCatalog(skills: SkillSummary[], options: SkillCatalogOptions = {}): SkillCatalog {
  const budgetChars = Math.max(0, Math.floor(options.budgetChars ?? SKILL_CATALOG_CHARS));
  const empty = { text: "", listed: 0, unlisted: skills.length, chars: 0, budgetChars };
  if (skills.length === 0 || budgetChars === 0) return empty;

  const sorted = [...skills].sort((a, b) => {
    const ap = SOURCE_PRIORITY[a.source ?? "user"] ?? 3;
    const bp = SOURCE_PRIORITY[b.source ?? "user"] ?? 3;
    if (ap !== bp) return ap - bp;
    // Code-point order, not locale collation: the prompt must be byte-identical across runtimes.
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const lines: string[] = [];
  let used = 0;
  for (const skill of sorted) {
    const line = formatSkillLine(skill);
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return empty;

  const unlisted = sorted.length - lines.length;
  if (unlisted > 0) {
    lines.push(
      options.searchable
        ? `- … and ${unlisted} more skills not listed here; use skill_search to find them.`
        : `- … and ${unlisted} more skills not listed here.`,
    );
  }
  const text = [
    SKILL_CATALOG_HEADING,
    SKILL_CATALOG_INTRO,
    ...lines,
  ].join("\n");
  return { text, listed: sorted.length - unlisted, unlisted, chars: used, budgetChars };
}

/** The catalog section text (see buildSkillCatalog). */
export function formatSkillsPrompt(skills: SkillSummary[], options: SkillCatalogOptions = {}): string {
  return buildSkillCatalog(skills, options).text;
}

function formatSkillLine(skill: SkillSummary): string {
  const raw = (skill.description ?? "").replace(/\s+/g, " ").trim();
  // Cut by code points so an emoji is never split into a lone surrogate, which some APIs reject.
  const points = Array.from(raw);
  const desc = points.length > SKILL_CATALOG_DESC_CHARS
    ? points.slice(0, SKILL_CATALOG_DESC_CHARS - 1).join("").trimEnd() + "…"
    : raw;
  return desc ? `- ${skill.name}: ${desc}` : `- ${skill.name}`;
}
