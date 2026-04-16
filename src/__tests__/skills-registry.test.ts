import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/registry.js";

function makeTempRoot(name: string): string {
  const root = join(tmpdir(), `bubble-skills-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("SkillRegistry", () => {
  it("discovers prompt-visible skills from project and user roots", () => {
    const root = makeTempRoot("visible");
    const bubbleHome = join(root, "home");
    const agentsHome = join(root, "agents");
    const cwd = join(root, "project");

    mkdirSync(join(bubbleHome, "skills", "repo-review"), { recursive: true });
    writeFileSync(
      join(bubbleHome, "skills", "repo-review", "SKILL.md"),
      `---
description: Review a codebase for architecture and risks.
tags:
  - review
  - architecture
---

Use this skill for repo reviews.
`,
    );

    mkdirSync(join(agentsHome, "skills", "podcast"), { recursive: true });
    writeFileSync(
      join(agentsHome, "skills", "podcast", "SKILL.md"),
      `---
description: Turn a source into a Chinese podcast script.
tags:
  - audio
---

Use this skill for podcast generation.
`,
    );

    mkdirSync(join(cwd, ".bubble", "skills", "frontend-refine"), { recursive: true });
    writeFileSync(
      join(cwd, ".bubble", "skills", "frontend-refine", "SKILL.md"),
      `---
description: Improve UI polish and spacing.
---

Use this skill for UI cleanup.
`,
    );

    const registry = new SkillRegistry({ cwd, bubbleHome, agentsHome });
    const summaries = registry.summaries();

    expect(summaries).toHaveLength(3);
    expect(summaries.map((skill) => skill.name)).toEqual(["frontend-refine", "podcast", "repo-review"]);
    expect(summaries.find((skill) => skill.name === "repo-review")?.tags).toEqual(["review", "architecture"]);
    expect(summaries.find((skill) => skill.name === "podcast")?.tags).toEqual(["audio"]);
  });

  it("hides skills marked disable-model-invocation from prompt summaries", () => {
    const root = makeTempRoot("hidden");
    const agentsHome = join(root, "agents");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".bubble", "skills", "internal-skill"), { recursive: true });
    writeFileSync(
      join(cwd, ".bubble", "skills", "internal-skill", "SKILL.md"),
      `---
description: Internal workflow.
disable-model-invocation: true
---

Do not expose this to the model.
`,
    );

    const registry = new SkillRegistry({ cwd, bubbleHome: join(root, "home"), agentsHome });
    expect(registry.all()).toHaveLength(1);
    expect(registry.summaries()).toHaveLength(0);
  });
});
