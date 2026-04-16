import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";

describe("skills prompt", () => {
  it("includes available skill summaries without injecting full skill bodies", () => {
    const prompt = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      configuredModelId: "openai:gpt-5.4",
      skills: [
        {
          name: "repo-review",
          description: "Review a codebase for architecture and risks.",
          tags: ["review", "architecture"],
        },
      ],
    });

    expect(prompt).toContain("Skills provide specialized instructions and workflows for specific tasks.");
    expect(prompt).toContain("Available skills:");
    expect(prompt).toContain("- repo-review: Review a codebase for architecture and risks. [tags: review, architecture]");
    expect(prompt).not.toContain("Use this skill for repo reviews.");
  });
});
