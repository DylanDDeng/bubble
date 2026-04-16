import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { SkillDiagnostic, SkillMeta, SkillRecord, SkillResourceIndex } from "./types.js";

export interface DiscoverSkillsOptions {
  roots: Array<{ path: string; source: SkillRecord["source"] }>;
}

export interface DiscoverSkillsResult {
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
}

export function discoverSkills(options: DiscoverSkillsOptions): DiscoverSkillsResult {
  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillRecord[] = [];
  const seenNames = new Map<string, string>();

  for (const root of options.roots) {
    if (!existsSync(root.path)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(root.path);
    } catch (error: any) {
      diagnostics.push({
        level: "warning",
        filePath: root.path,
        message: `Failed to read skill root: ${error.message || String(error)}`,
      });
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(root.path, entry);
      let stat;
      try {
        stat = statSync(entryPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const skillFile = join(entryPath, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const parsed = loadSkillRecord(skillFile, root.source);
      diagnostics.push(...parsed.diagnostics);
      if (!parsed.skill) continue;

      const existing = seenNames.get(parsed.skill.meta.name);
      if (existing) {
        diagnostics.push({
          level: "error",
          skillName: parsed.skill.meta.name,
          filePath: skillFile,
          message: `Duplicate skill name "${parsed.skill.meta.name}" already defined at ${existing}`,
        });
        continue;
      }

      seenNames.set(parsed.skill.meta.name, skillFile);
      skills.push(parsed.skill);
    }
  }

  skills.sort((a, b) => a.meta.name.localeCompare(b.meta.name));

  return { skills, diagnostics };
}

function loadSkillRecord(skillFile: string, source: SkillRecord["source"]): { skill?: SkillRecord; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  let raw = "";
  try {
    raw = readFileSync(skillFile, "utf8");
  } catch (error: any) {
    diagnostics.push({
      level: "error",
      filePath: skillFile,
      message: `Failed to read skill file: ${error.message || String(error)}`,
    });
    return { diagnostics };
  }

  const { attributes, body } = parseFrontmatter(raw);
  const rootDir = skillFile.slice(0, -"/SKILL.md".length);
  const fallbackName = basename(rootDir);
  const meta = normalizeMeta(attributes, fallbackName, skillFile, diagnostics);
  if (!meta) {
    return { diagnostics };
  }

  return {
    skill: {
      meta,
      rootDir,
      skillFile,
      content: body.trim(),
      resources: indexResources(rootDir),
      source,
    },
    diagnostics,
  };
}

function normalizeMeta(
  attributes: Record<string, unknown>,
  fallbackName: string,
  filePath: string,
  diagnostics: SkillDiagnostic[],
): SkillMeta | undefined {
  const name = typeof attributes.name === "string" && attributes.name.trim() ? attributes.name.trim() : fallbackName;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    diagnostics.push({
      level: "error",
      skillName: name,
      filePath,
      message: `Invalid skill name "${name}"`,
    });
    return undefined;
  }

  const description = typeof attributes.description === "string" ? attributes.description.trim() : "";
  if (!description) {
    diagnostics.push({
      level: "error",
      skillName: name,
      filePath,
      message: "Skill description is required",
    });
    return undefined;
  }

  const tags = Array.isArray(attributes.tags)
    ? attributes.tags.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
    : undefined;

  return {
    name,
    description,
    disableModelInvocation: attributes["disable-model-invocation"] === true,
    version: typeof attributes.version === "number" ? attributes.version : undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
  };
}

function indexResources(rootDir: string): SkillResourceIndex {
  return {
    references: listRelativeFiles(join(rootDir, "references"), rootDir),
    scripts: listRelativeFiles(join(rootDir, "scripts"), rootDir),
    assets: listRelativeFiles(join(rootDir, "assets"), rootDir),
  };
}

function listRelativeFiles(targetDir: string, rootDir: string): string[] {
  if (!existsSync(targetDir)) return [];
  const results: string[] = [];
  walkDir(targetDir, rootDir, results);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function walkDir(targetDir: string, rootDir: string, results: string[]) {
  for (const entry of readdirSync(targetDir)) {
    const fullPath = join(targetDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, rootDir, results);
      continue;
    }
    results.push(fullPath.slice(rootDir.length + 1).replace(/\\/g, "/"));
  }
}

