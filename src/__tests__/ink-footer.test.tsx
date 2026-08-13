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

    expect(output).toContain("plan on");
    expect(output).not.toContain("⇧⇥");
    // With no status data supplied, only the badge renders — the cwd/branch/
    // model/title/ctx segments appear only when their data is present.
    expect(output).not.toContain("Model:");
    expect(output).not.toContain("ctx ");
    expect(output).not.toContain("•");
  });

  it("renders the status line with cwd, branch, model, title, and context", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: {
          cwd: "~/project",
          branch: "main",
          model: "Grok 4.6",
          sessionTitle: "fix the footer",
          contextUsage: "12% context",
        },
      }),
      { columns: 100 },
    );

    expect(output).toContain("~/project");
    expect(output).toContain("main");
    expect(output).toContain("Grok 4.6");
    expect(output).toContain("fix the footer");
    expect(output).toContain("12% context");
    expect(output).toContain(" | ");
  });

  it("places the permission badge first in the status line", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: { cwd: "~/project", branch: "main", model: "Grok 4.6", mode: "bypassPermissions" },
      }),
      { columns: 100 },
    );

    expect(output).toContain("bypass permission on");
    expect(output).toContain(" | ");
    expect(output.indexOf("bypass permission on")).toBeLessThan(output.indexOf("~/project"));
  });

  it("spells out the bypass badge as 'bypass permission on'", () => {
    const output = renderToString(
      React.createElement(FooterBar, { data: { mode: "bypassPermissions" } }),
      { columns: 100 },
    );

    expect(output).toContain("bypass permission on");
    expect(output).not.toContain("⇧⇥");
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
