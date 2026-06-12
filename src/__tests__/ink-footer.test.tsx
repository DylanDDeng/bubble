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
          verboseTrace: true,
        },
      }),
      { columns: 100 },
    );

    expect(output).toContain("deepseek");
    expect(output).toContain("deepseek-v4-flash");
    expect(output).not.toContain("details");
  });

  it("stays free of token usage and context gauge chrome", () => {
    const output = renderToString(
      React.createElement(FooterBar, {
        data: {
          cwd: "/tmp/project",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          thinkingLevel: "off",
          showThinking: false,
        },
      }),
      { columns: 100 },
    );

    expect(output).not.toContain("ctx ");
    expect(output).not.toContain("↑");
    expect(output).not.toContain("↓");
  });
});
