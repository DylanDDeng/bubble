import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";

describe("skills prompt", () => {
  it("keeps skill summaries out of the system prompt and advertises skill_search", () => {
    const prompt = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      configuredModelId: "openai:gpt-5.4",
      tools: ["read", "skill_search", "skill"],
      skills: [
        {
          name: "repo-review",
          description: "Review a codebase for architecture and risks.",
          tags: ["review", "architecture"],
        },
      ],
    });

    expect(prompt).toContain("- skill_search: Search available skills by name, description, tags, and source");
    expect(prompt).toContain("call skill_search to find relevant skills");
    expect(prompt).not.toContain("Available skills:");
    expect(prompt).not.toContain("- repo-review: Review a codebase for architecture and risks. [tags: review, architecture]");
    expect(prompt).not.toContain("Use this skill for repo reviews.");
  });
});
