import { join } from "node:path";
import { homedir } from "node:os";
import { getBubbleHome } from "../bubble-home.js";
import { discoverSkills } from "./discovery.js";
import type { SkillDiagnostic, SkillRecord, SkillSummary } from "./types.js";

export interface SkillRegistryOptions {
  cwd?: string;
  bubbleHome?: string;
  agentsHome?: string;
  claudeHome?: string;
  skillPaths?: string[];
  disabledSkills?: string[];
  onDisabledSkillsChange?: (disabledSkills: string[]) => void;
}

export class SkillRegistry {
  private skills: SkillRecord[] = [];
  private diagnostics: SkillDiagnostic[] = [];
  private readonly roots: Array<{ path: string; source: SkillRecord["source"] }>;
  private readonly disabledSkills: Set<string>;
  private readonly onDisabledSkillsChange?: (disabledSkills: string[]) => void;

  constructor(options: SkillRegistryOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const bubbleHome = options.bubbleHome ?? getBubbleHome();
    const agentsHome = options.agentsHome ?? join(homedir(), ".agents");
    const claudeHome = options.claudeHome ?? join(homedir(), ".claude");
    this.roots = [
      { path: join(bubbleHome, "skills"), source: "user" as const },
      { path: join(agentsHome, "skills"), source: "user" as const },
      { path: join(claudeHome, "skills"), source: "user" as const },
      { path: join(cwd, ".bubble", "skills"), source: "project" as const },
      ...(options.skillPaths ?? []).map((path) => ({ path, source: "configured" as const })),
    ];
    this.disabledSkills = new Set(options.disabledSkills ?? []);
    this.onDisabledSkillsChange = options.onDisabledSkillsChange;
    this.reload();
  }

  reload(): void {
    const result = discoverSkills({ roots: this.roots });
    this.skills = result.skills;
    this.diagnostics = result.diagnostics;
  }

  all(): SkillRecord[] {
    return this.skills.slice();
  }

  promptVisible(): SkillRecord[] {
    return this.skills.filter((skill) => (
      this.isEnabled(skill.meta.name) && !skill.meta.disableModelInvocation
    ));
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
    if (!this.isEnabled(name)) return undefined;
    return this.getAny(name);
  }

  getAny(name: string): SkillRecord | undefined {
    return this.skills.find((skill) => skill.meta.name === name);
  }

  isEnabled(name: string): boolean {
    return !this.disabledSkills.has(name);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.getAny(name)) return false;
    let changed = false;
    if (enabled) {
      changed = this.disabledSkills.delete(name);
    } else if (!this.disabledSkills.has(name)) {
      this.disabledSkills.add(name);
      changed = true;
    }
    if (!changed) return false;
    this.onDisabledSkillsChange?.([...this.disabledSkills].sort((a, b) => a.localeCompare(b)));
    return true;
  }

  getDisabledSkillNames(): string[] {
    return [...this.disabledSkills].sort((a, b) => a.localeCompare(b));
  }

  getDiagnostics(): SkillDiagnostic[] {
    return this.diagnostics.slice();
  }
}
