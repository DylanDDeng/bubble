import { describe, expect, it } from "vitest";
import { shouldShowWelcomeBanner } from "../tui-opentui/welcome.js";
import type { DisplayMessage } from "../tui-opentui/display-history.js";

describe("OpenTUI welcome surface", () => {
  it("shows only before the first visible fresh-session message", () => {
    const user: DisplayMessage = {
      key: "user-1",
      role: "user",
      content: "What is this project?",
    };

    expect(shouldShowWelcomeBanner({
      messages: [],
      startedWithVisibleHistory: false,
    })).toBe(true);
    expect(shouldShowWelcomeBanner({
      messages: [user],
      startedWithVisibleHistory: false,
    })).toBe(false);
  });

  it("does not show over restored history", () => {
    const assistant: DisplayMessage = {
      key: "assistant-1",
      role: "assistant",
      content: "Existing reply",
    };

    expect(shouldShowWelcomeBanner({
      messages: [assistant],
      startedWithVisibleHistory: true,
    })).toBe(false);
  });

  it("ignores non-rendered synthetic summaries", () => {
    expect(shouldShowWelcomeBanner({
      messages: [{ role: "assistant", syntheticKind: "ui_summary" }],
      startedWithVisibleHistory: false,
    })).toBe(true);
  });
});
