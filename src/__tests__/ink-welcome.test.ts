import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { WelcomeBanner, shouldShowWelcomeBanner } from "../tui-ink/welcome.js";
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

  it("renders the thin brand header information", () => {
    const output = renderToString(
      React.createElement(WelcomeBanner, {
        terminalColumns: 100,
        tips: ["Ready with deepseek-v4-flash", "Type @ to reference a file", "Type / for commands and skills"],
      }),
      { columns: 100 },
    );

    // Adaptive sizing: at 100 columns the banner renders the large
    // pixel-block wordmark (dd65dfb parity).
    expect(output).toContain("██▀▀██");
    expect(output).toContain("TIP:");
    // Keyboard hints, model · cwd, and Skills/MCPs/AGENTS.md status chrome
    // were removed from the banner on purpose — keep it minimal.
    expect(output).not.toContain("shift+tab");
    expect(output).not.toContain("Skills");
    expect(output).not.toContain("MCPs");
    expect(output).not.toContain("AGENTS.md");
  });
});
