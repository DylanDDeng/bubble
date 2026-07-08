import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { WelcomeBanner, formatModelLine, shouldShowWelcomeBanner } from "../tui-ink/welcome.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

describe("Ink welcome banner", () => {
  it("stays visible through the first fresh-session user turn", () => {
    const firstUser: DisplayMessage = {
      key: "user-1",
      role: "user",
      content: "What is this project?",
    };

    expect(shouldShowWelcomeBanner({
      messages: [],
      startedWithVisibleHistory: false,
    })).toBe(true);
    expect(shouldShowWelcomeBanner({
      messages: [firstUser],
      startedWithVisibleHistory: false,
    })).toBe(true);
  });

  it("stays visible for a fresh-session conversation", () => {
    const firstUser: DisplayMessage = {
      key: "user-1",
      role: "user",
      content: "First",
    };
    const firstAssistant: DisplayMessage = {
      key: "assistant-1",
      role: "assistant",
      content: "Done",
    };
    const secondUser: DisplayMessage = {
      key: "user-2",
      role: "user",
      content: "Second",
    };

    expect(shouldShowWelcomeBanner({
      messages: [firstUser, firstAssistant, secondUser],
      startedWithVisibleHistory: false,
    })).toBe(true);
  });

  it("hides for restored history", () => {
    const firstUser: DisplayMessage = {
      key: "user-1",
      role: "user",
      content: "First",
    };

    expect(shouldShowWelcomeBanner({
      messages: [firstUser],
      startedWithVisibleHistory: true,
    })).toBe(false);
  });

  it("stays visible across overlay open/close", () => {
    // Regression: when a picker opens, an earlier version flipped this to
    // false via `hasOverlay`, moving the banner relative to transcript items
    // when the picker closed.
    expect(shouldShowWelcomeBanner({
      messages: [],
      startedWithVisibleHistory: false,
    })).toBe(true);
  });

  it("renders a boxed welcome banner with labeled info rows", () => {
    const output = renderToString(
      React.createElement(WelcomeBanner, {
        terminalColumns: 100,
        tips: ["Ready with deepseek-v4-flash", "Type @ to reference a file", "Type / for commands and skills"],
        cwd: "~/coworker",
        sessionLabel: "2026-06-12T14-23-38-047Z",
        providerId: "openai",
        modelLabel: "gpt-5.5",
        thinkingLabel: "xhigh",
      }),
      { columns: 100 },
    );

    expect(output).toContain("Welcome to Bubble!");
    expect(output).toContain("I am a cat and you can send /help");
    expect(output).toContain("Directory:");
    expect(output).toContain("~/coworker");
    expect(output).toContain("Session:");
    expect(output).toContain("2026-06-12T14-23-38-047Z");
    expect(output).toContain("Model:");
    expect(output).toContain("gpt-5.5 with xhigh effort · openai");
    expect(output).toContain("Version:");
    expect(output).toContain("v0.0.");
    expect(output).toContain("██████");
    expect(output).toContain("╭");
    expect(output).toContain("╰");
    expect(output).not.toContain("██▀▀██");
    expect(output).not.toContain("TIP:");
    expect(output).not.toContain("shift+tab");
    expect(output).not.toContain("Skills");
    expect(output).not.toContain("MCPs");
    expect(output).not.toContain("AGENTS.md");
  });

  it("formats the compact model line", () => {
    expect(formatModelLine({
      tips: [],
      providerId: "anthropic",
      modelLabel: "Opus 4.8 (1M context)",
      thinkingLabel: "high",
    })).toBe("Opus 4.8 (1M context) with high effort · anthropic");
  });

  it("labels MiniMax thinking as a mode, not a graded effort", () => {
    expect(formatModelLine({
      tips: [],
      providerId: "minimax-anthropic",
      modelId: "MiniMax-M3",
      modelLabel: "MiniMax M3",
      thinkingLabel: "medium",
    })).toBe("MiniMax M3 · thinking mode");
  });

  it("labels Kimi K2.6 thinking as a mode, not medium effort", () => {
    expect(formatModelLine({
      tips: [],
      providerId: "kimi-for-coding",
      modelId: "kimi-k2.6",
      modelLabel: "Kimi K2.6",
      thinkingLabel: "medium",
    })).toBe("Kimi K2.6 · thinking mode · kimi-for-coding");
  });

  it("labels Kimi K2.7 Code thinking-only models as a mode", () => {
    expect(formatModelLine({
      tips: [],
      providerId: "kimi-for-coding",
      modelId: "kimi-k2.7-code-highspeed",
      modelLabel: "Kimi K2.7 Code Highspeed",
      thinkingLabel: "medium",
    })).toBe("Kimi K2.7 Code Highspeed · thinking mode · kimi-for-coding");
  });
});
