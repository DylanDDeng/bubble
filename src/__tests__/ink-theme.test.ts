import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { InputBox } from "../tui-ink/input-box.js";
import { ThemeProvider, lightTheme, paletteFor } from "../tui-ink/theme.js";

describe("Ink light theme", () => {
  it("inherits the terminal background instead of painting a canvas", () => {
    // A painted canvas fights terminals whose background differs from ours
    // (pure black inside a soft-dark terminal, cream inside a white one), so
    // both palettes leave the canvas unpainted by default.
    expect(paletteFor("light").background).toBeUndefined();
    expect(paletteFor("dark").background).toBeUndefined();
  });

  it("lets config overrides force a painted canvas", () => {
    expect(paletteFor("dark", { background: "#0A0A0A" }).background).toBe("#0A0A0A");
  });

  it("keeps a distinct light composer surface", () => {
    const theme = paletteFor("light");

    expect(theme.inputBg).toBe("#F1F3F0");
  });

  it("renders the composer under the light theme", () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        { value: lightTheme },
        React.createElement(InputBox, {
          onSubmit: () => {},
          terminalColumns: 40,
          cwd: "/tmp",
        }),
      ),
      { columns: 40 },
    );

    expect(output).toContain(">");
  });
});
