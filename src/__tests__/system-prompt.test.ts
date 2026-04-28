import { describe, expect, it } from "vitest";
import { reminderForMode } from "../prompt/reminders.js";
import { buildSystemPrompt } from "../system-prompt.js";

describe("system prompt", () => {
  it("includes provider-specific codex guidance and runtime context", () => {
    const prompt = buildSystemPrompt({
      agentName: "Bubble",
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      configuredModelId: "openai:gpt-5.4",
      thinkingLevel: "high",
      workingDir: "/tmp/project",
      currentDate: "2026-04-16",
    });

    expect(prompt).toContain("Bubble");
    expect(prompt).toContain("terminal-native coding assistant optimized for iterative coding work");
    expect(prompt).toContain("Configured provider: openai");
    expect(prompt).toContain("Configured model id: openai:gpt-5.4");
    expect(prompt).toContain("Current thinking level: high");
    expect(prompt).toContain("Current working directory: /tmp/project");
    expect(prompt).toContain("- glob: Find files by glob pattern without using bash");
    expect(prompt).toContain("Use glob for file discovery");
    expect(prompt).toContain("- question: Ask the user structured questions");
    expect(prompt).toContain("explicitly discussing, brainstorming, or shaping an approach");
  });

  it("keeps the system prompt identical across agent modes (cache-friendly)", () => {
    const defaultPrompt = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-4o",
      mode: "default",
    });
    const planPrompt = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-4o",
      mode: "plan",
    });
    expect(planPrompt).toBe(defaultPrompt);
    expect(defaultPrompt).not.toContain("PLAN MODE");
    expect(defaultPrompt).not.toContain("Current mode");
  });

  it("falls back to gemini-style provider guidance for google models", () => {
    const prompt = buildSystemPrompt({
      configuredProvider: "google",
      configuredModel: "gemini-2.5-pro-preview-03-25",
      configuredModelId: "google:gemini-2.5-pro-preview-03-25",
    });

    expect(prompt).toContain("coding assistant running inside a terminal workspace");
    expect(prompt).toContain("Configured provider: google");
  });

  it("only includes question guidance when the question tool is available", () => {
    const withoutQuestion = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      tools: ["read", "glob"],
    });
    const withQuestion = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      tools: ["read", "glob", "question"],
    });

    expect(withoutQuestion).not.toContain("- question:");
    expect(withoutQuestion).not.toContain("explicitly discussing, brainstorming, or shaping an approach");
    expect(withQuestion).toContain("- question: Ask the user structured questions");
    expect(withQuestion).toContain("explicitly discussing, brainstorming, or shaping an approach");
  });

  it("encourages targeted question tool usage in plan mode reminders", () => {
    const reminder = reminderForMode("plan");

    expect(reminder).toContain("question");
    expect(reminder).toContain("clarify important ambiguities, tradeoffs, requirements, or preference choices");
    expect(reminder).toContain("exit_plan_mode is the approval step");
  });
});
