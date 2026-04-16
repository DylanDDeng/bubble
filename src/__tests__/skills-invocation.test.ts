import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseSkillInvocation } from "../skills/invocation.js";
import { SkillRegistry } from "../skills/registry.js";

function createRegistry(): SkillRegistry {
  const root = join(tmpdir(), `bubble-skill-invoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".bubble", "skills", "podcast"), { recursive: true });
  writeFileSync(
    join(cwd, ".bubble", "skills", "podcast", "SKILL.md"),
    `---
description: Turn a source into a Chinese podcast script.
---

Use this skill for podcast generation workflows.
`,
  );
  return new SkillRegistry({ cwd, bubbleHome: join(root, "home") });
}

describe("skill invocation parsing", () => {
  it("parses /<skill-name> <task>", () => {
    const registry = createRegistry();
    const parsed = parseSkillInvocation("/podcast 请把这个链接做成播客稿", registry);

    expect(parsed?.skill.meta.name).toBe("podcast");
    expect(parsed?.task).toBe("请把这个链接做成播客稿");
    expect(parsed?.actualPrompt).toContain('Use the skill tool to load the "podcast" skill');
  });

  it("parses /skill <skill-name> <task>", () => {
    const registry = createRegistry();
    const parsed = parseSkillInvocation("/skill podcast 请把这个链接做成播客稿", registry);

    expect(parsed?.skill.meta.name).toBe("podcast");
    expect(parsed?.task).toBe("请把这个链接做成播客稿");
  });

  it("does not parse bare skill inspection commands", () => {
    const registry = createRegistry();
    expect(parseSkillInvocation("/podcast", registry)).toBeUndefined();
    expect(parseSkillInvocation("/skill podcast", registry)).toBeUndefined();
  });
});

