import { describe, expect, it } from "vitest";
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
});
