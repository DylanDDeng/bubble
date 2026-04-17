import { join } from "node:path";
import { homedir } from "node:os";
import { discoverSkills } from "./discovery.js";
import type { SkillDiagnostic, SkillRecord, SkillSummary } from "./types.js";

export interface SkillRegistryOptions {
  cwd?: string;
  bubbleHome?: string;
  agentsHome?: string;
  skillPaths?: string[];
}

export class SkillRegistry {
  private readonly skills: SkillRecord[];
  private readonly diagnostics: SkillDiagnostic[];

  constructor(options: SkillRegistryOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const bubbleHome = options.bubbleHome ?? process.env.BUBBLE_HOME ?? join(homedir(), ".bubble");
    const agentsHome = options.agentsHome ?? join(homedir(), ".agents");
    const roots = [
      { path: join(bubbleHome, "skills"), source: "user" as const },
      { path: join(agentsHome, "skills"), source: "user" as const },
      { path: join(cwd, ".bubble", "skills"), source: "project" as const },
      ...(options.skillPaths ?? []).map((path) => ({ path, source: "configured" as const })),
    ];
    const result = discoverSkills({ roots });
    this.skills = result.skills;
    this.diagnostics = result.diagnostics;
  }

  all(): SkillRecord[] {
    return this.skills.slice();
  }

  promptVisible(): SkillRecord[] {
    return this.skills.filter((skill) => !skill.meta.disableModelInvocation);
  }

  summaries(): SkillSummary[] {
    return this.promptVisible().map((skill) => ({
      name: skill.meta.name,
      description: skill.meta.description,
      tags: skill.meta.tags,
      source: skill.source,
    }));
  }

  get(name: string): SkillRecord | undefined {
    return this.skills.find((skill) => skill.meta.name === name);
  }

  getDiagnostics(): SkillDiagnostic[] {
    return this.diagnostics.slice();
  }
}
