import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../../skills/registry.js";
import { closestSkillNames, createSkillTool } from "../skill.js";

function makeTempRoot(name: string): string {
  const root = join(tmpdir(), `bubble-skill-tool-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("skill tool", () => {
  it("loads skill content and resource paths on demand", async () => {
    const root = makeTempRoot("load");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".bubble", "skills", "repo-review", "references"), { recursive: true });
    mkdirSync(join(cwd, ".bubble", "skills", "repo-review", "scripts"), { recursive: true });
    writeFileSync(
      join(cwd, ".bubble", "skills", "repo-review", "SKILL.md"),
      `---
description: Review a codebase for architecture and risks.
---

Read the repo carefully before proposing changes.
`,
    );
    writeFileSync(join(cwd, ".bubble", "skills", "repo-review", "references", "guide.md"), "# guide");
    writeFileSync(join(cwd, ".bubble", "skills", "repo-review", "scripts", "helper.js"), "console.log('ok')");

    const registry = new SkillRegistry({ cwd, bubbleHome: join(root, "home") });
    const tool = createSkillTool(registry);
    const result = await tool.execute({ name: "repo-review" }, { cwd });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Skill: repo-review");
    expect(result.content).toContain("Description: Review a codebase for architecture and risks.");
    expect(result.content).toContain("Base directory:");
    expect(result.content).toContain("Read the repo carefully before proposing changes.");
    expect(result.content).toContain("- references/guide.md");
    expect(result.content).toContain("- scripts/helper.js");
  });

  it("returns a helpful error for unknown skills", async () => {
    const root = makeTempRoot("unknown");
    const registry = new SkillRegistry({ cwd: join(root, "project"), bubbleHome: join(root, "home") });
    const tool = createSkillTool(registry);
    const result = await tool.execute({ name: "missing-skill" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown skill "missing-skill"');
    expect(result.content).toContain("exact name from the Skills section");
    // Shared with children that have no skill_search, so it never points there.
    expect(result.content).not.toContain("skill_search");
    expect(tool.description).not.toContain("skill_search");
  });

  it("suggests the closest known names for a mistyped skill", () => {
    const names = ["bubble-design", "repo-review", "release-notes"];
    expect(closestSkillNames("bubble-desgin", names)).toEqual(["bubble-design"]);
    expect(closestSkillNames("review", names)).toEqual(["repo-review"]);
    expect(closestSkillNames("kubernetes", names)).toEqual([]);
    // A two-letter fragment is not a match.
    expect(closestSkillNames("re", names)).toEqual([]);
  });
});
