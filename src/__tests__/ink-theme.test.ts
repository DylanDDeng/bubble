import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { InputBox } from "../tui-ink/input-box.js";
import { ThemeProvider, lightTheme, paletteFor } from "../tui-ink/theme.js";

describe("Ink light theme", () => {
  it("uses a paper canvas and a distinct light composer surface", () => {
    const theme = paletteFor("light");

    expect(theme.background).toBe("#FCFCFA");
    expect(theme.inputBg).toBe("#F1F3F0");
    expect(theme.inputBg).not.toBe(theme.background);
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
