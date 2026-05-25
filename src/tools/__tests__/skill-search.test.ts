import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../../skills/registry.js";
import { createSkillSearchTool, searchSkillSummaries } from "../skill-search.js";

function makeTempRoot(name: string): string {
  const root = join(tmpdir(), `bubble-skill-search-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeSkill(root: string, name: string, frontmatter: string, body = "Instructions."): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("skill_search tool", () => {
  it("searches prompt-visible skills and prefers project skills", async () => {
    const root = makeTempRoot("ranking");
    const cwd = join(root, "project");
    const bubbleHome = join(root, "home");
    writeSkill(
      join(bubbleHome, "skills"),
      "global-review",
      `description: Review code from the global library.\ntags: [review]`,
    );
    writeSkill(
      join(cwd, ".bubble", "skills"),
      "project-review",
      `description: Review this project architecture.\ntags: [review, architecture]`,
    );
    writeSkill(
      join(cwd, ".bubble", "skills"),
      "hidden-review",
      `description: Hidden review workflow.\ndisable-model-invocation: true\ntags: [review]`,
    );

    const registry = new SkillRegistry({
      cwd,
      bubbleHome,
      agentsHome: join(root, "agents"),
      claudeHome: join(root, "claude"),
    });
    const tool = createSkillSearchTool(registry);
    const result = await tool.execute({ query: "review", max_results: 10 }, { cwd });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Skill search results");
    expect(result.content).toContain("- project-review (project): Review this project architecture.");
    expect(result.content).toContain("- global-review (user): Review code from the global library.");
    expect(result.content).not.toContain("hidden-review");
    expect(result.content.indexOf("project-review")).toBeLessThan(result.content.indexOf("global-review"));
  });

  it("ranks exact name matches above broad description matches", () => {
    const matches = searchSkillSummaries([
      { name: "content-research", description: "Research and write content", source: "user" },
      { name: "research", description: "General workflow", source: "user" },
      { name: "project-helper", description: "Research helper", source: "project" },
    ], "research");

    expect(matches.map((match) => match.skill.name)).toEqual([
      "research",
      "content-research",
      "project-helper",
    ]);
  });

  it("matches Chinese phrase queries with CJK bigrams", () => {
    const matches = searchSkillSummaries([
      { name: "baoyu-image-gen", description: "AI image generation with OpenAI APIs", source: "user" },
      { name: "gemini-image", description: "当用户想要生成图片、画图、绘画、创建图像时使用此 Skill。", source: "user" },
    ], "帮我生成图片");

    expect(matches[0]?.skill.name).toBe("gemini-image");
  });

  it("handles no matches without dumping every skill name", async () => {
    const root = makeTempRoot("none");
    const cwd = join(root, "project");
    writeSkill(
      join(cwd, ".bubble", "skills"),
      "repo-review",
      "description: Review a codebase.",
    );
    const registry = new SkillRegistry({
      cwd,
      bubbleHome: join(root, "home"),
      agentsHome: join(root, "agents"),
      claudeHome: join(root, "claude"),
    });
    const tool = createSkillSearchTool(registry);
    const result = await tool.execute({ query: "video podcast" }, { cwd });

    expect(result.content).toContain('No skills matched "video podcast"');
    expect(result.content).not.toContain("repo-review");
  });
});
