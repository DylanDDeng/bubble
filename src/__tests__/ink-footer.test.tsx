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
});
