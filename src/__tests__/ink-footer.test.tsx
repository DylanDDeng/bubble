import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { FooterBar } from "../tui-ink/footer.js";

describe("Ink footer", () => {
  it("renders nothing in the default permission mode", () => {
    const output = renderToString(
      React.createElement(FooterBar, { data: { mode: "default" } }),
      { columns: 100 },
    );

    expect(output.trim()).toBe("");
  });

  it("renders the goal indicator even in the default permission mode", () => {
    const output = renderToString(
      React.createElement(FooterBar, { data: { mode: "default", goalLine: "goal: active · ship it" } }),
      { columns: 100 },
    );

    expect(output).toContain("goal: active");
    expect(output).not.toContain("⇧⇥");
  });

  it("shows only the permission-mode badge for non-default modes", () => {
    const output = renderToString(
      React.createElement(FooterBar, { data: { mode: "plan" } }),
      { columns: 100 },
    );

    expect(output).toContain("on");
    expect(output).toContain("⇧⇥");
    // Path / provider / model chrome lives in the welcome banner now.
    expect(output).not.toContain("ctx ");
    expect(output).not.toContain("•");
  });

  it("keeps the Grok chat-only boundary visible", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: { runtimeLabel: "Grok subscription · chat-only · no workspace access" },
      }),
      { columns: 100 },
    );

    expect(output.trim()).toBe("Grok subscription · chat-only · no workspace access");
    expect(output).not.toContain("⇧⇥");
  });
});
