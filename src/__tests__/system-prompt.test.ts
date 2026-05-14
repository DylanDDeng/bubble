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
    // Thinking level is intentionally not surfaced in the prompt anymore — it's
    // a meta-decision point that triggers redundant deliberation in reasoning
    // models. The API param carries it instead.
    expect(prompt).not.toContain("Current thinking level");
    // Execution protocol is prose now, not numbered list — keep the test asserting
    // the substance (verification expectation) is still surfaced.
    expect(prompt).not.toContain("Execution protocol:\n1.");
    expect(prompt).toContain("Work by understanding the requested outcome");
    expect(prompt).toContain("verifying when possible");
    expect(prompt).toMatch(/If a tool fails, diagnose the error/);
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

  it("uses provider-specific prompts for DeepSeek, Kimi, and GLM families", () => {
    const deepseek = buildSystemPrompt({
      configuredProvider: "deepseek",
      configuredModel: "deepseek-v4-pro",
      configuredModelId: "deepseek:deepseek-v4-pro",
    });
    const kimi = buildSystemPrompt({
      configuredProvider: "moonshot-cn",
      configuredModel: "kimi-k2.6",
      configuredModelId: "moonshot-cn:kimi-k2.6",
    });
    const fireworksKimi = buildSystemPrompt({
      configuredProvider: "fireworks",
      configuredModel: "K2.6",
      configuredModelId: "fireworks:accounts/fireworks/models/kimi-k2p6",
    });
    const glm = buildSystemPrompt({
      configuredProvider: "zai",
      configuredModel: "glm-5.1",
      configuredModelId: "zai:glm-5.1",
    });

    expect(deepseek).toContain("running on a DeepSeek model");
    expect(deepseek).not.toContain("inspect serialization");
    expect(kimi).toContain("running on a Kimi/Moonshot model");
    expect(kimi).toContain("Keep tool use disciplined");
    expect(kimi).toContain("Evidence-first project exploration");
    expect(kimi).not.toContain("message history serialization");
    expect(fireworksKimi).toContain("running on a Kimi/Moonshot model");
    expect(glm).toContain("running on a GLM/Z.AI model");
    expect(glm).toContain("identify the failing boundary");
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

  it("includes memory prompt sections when provided", () => {
    const prompt = buildSystemPrompt({
      configuredProvider: "openai",
      configuredModel: "gpt-5.4",
      memoryPrompt: "## Persistent Memory\n- remember project conventions",
    });

    expect(prompt).toContain("## Persistent Memory");
    expect(prompt).toContain("remember project conventions");
  });

  it("encourages targeted question tool usage in plan mode reminders", () => {
    const reminder = reminderForMode("plan");

    expect(reminder).toContain("question");
    expect(reminder).toContain("clarify important ambiguities, tradeoffs, requirements, or preference choices");
    expect(reminder).toContain("exit_plan_mode is the approval step");
    expect(reminder).toContain("Do not edit files");
  });
});
