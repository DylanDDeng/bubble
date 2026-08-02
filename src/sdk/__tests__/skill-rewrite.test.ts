import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { rewriteSkillInvocationPrompt } from "../index.js";
import { SkillRegistry } from "../../skills/registry.js";
import type { ContentPart } from "../../types.js";

function createRegistry(): SkillRegistry {
  const root = join(tmpdir(), `bubble-sdk-rewrite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  return new SkillRegistry({
    cwd,
    bubbleHome: join(root, "home"),
    agentsHome: join(root, "agents"),
    claudeHome: join(root, "claude"),
  });
}

describe("rewriteSkillInvocationPrompt", () => {
  it("rewrites a string skill invocation like the TUI", () => {
    const registry = createRegistry();
    const rewritten = rewriteSkillInvocationPrompt("/podcast 帮我做成播客稿", registry);
    expect(rewritten).toContain('Use the skill tool to load the "podcast" skill');
    expect(rewritten).toContain("帮我做成播客稿");
  });

  it("passes through non-invocations untouched", () => {
    const registry = createRegistry();
    expect(rewriteSkillInvocationPrompt("普通消息", registry)).toBe("普通消息");
    expect(rewriteSkillInvocationPrompt("/unknown-skill do it", registry)).toBe("/unknown-skill do it");
    expect(rewriteSkillInvocationPrompt("/podcast", registry)).toBe("/podcast");
  });

  it("rewrites the first text part of a ContentPart[] prompt, preserving images", () => {
    const registry = createRegistry();
    const parts: ContentPart[] = [
      { type: "text", text: "/podcast 帮我做成播客稿" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    const rewritten = rewriteSkillInvocationPrompt(parts, registry) as ContentPart[];
    expect(rewritten).not.toBe(parts);
    expect(rewritten[0].type).toBe("text");
    expect((rewritten[0] as { text: string }).text).toContain('Use the skill tool to load the "podcast" skill');
    expect(rewritten[1]).toBe(parts[1]);
    // original array untouched
    expect((parts[0] as { text: string }).text).toBe("/podcast 帮我做成播客稿");
  });

  it("leaves image-only prompts alone", () => {
    const registry = createRegistry();
    const parts: ContentPart[] = [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }];
    expect(rewriteSkillInvocationPrompt(parts, registry)).toBe(parts);
  });
});
