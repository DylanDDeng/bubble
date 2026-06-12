import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { FooterBar } from "../tui-ink/footer.js";

describe("Ink footer", () => {
  it("keeps the model at the right edge without trace details chrome", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: {
          cwd: "/tmp/project",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          thinkingLevel: "off",
          showThinking: false,
          usageTotals: { prompt: 0, completion: 0 },
          verboseTrace: true,
        },
      }),
      { columns: 100 },
    );

    expect(output).toContain("deepseek");
    expect(output).toContain("deepseek-v4-flash");
    expect(output).not.toContain("details");
  });

  it("shows the context gauge when a percent is available", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: {
          cwd: "/tmp/project",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          thinkingLevel: "off",
          showThinking: false,
          usageTotals: { prompt: 1200, completion: 300 },
          contextPercent: 42,
        },
      }),
      { columns: 100 },
    );

    expect(output).toContain("ctx 42%");
  });

  it("omits the context gauge when no window is known", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: {
          cwd: "/tmp/project",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          thinkingLevel: "off",
          showThinking: false,
          usageTotals: { prompt: 0, completion: 0 },
        },
      }),
      { columns: 100 },
    );

    expect(output).not.toContain("ctx ");
  });
});
