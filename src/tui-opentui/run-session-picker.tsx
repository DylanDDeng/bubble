/** @jsxImportSource @opentui/react */
import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SessionPicker } from "./session-picker.js";
import { ThemeProvider, paletteFor } from "./theme.js";
import type { ResolvedTheme } from "./detect-theme.js";
import type { SessionSummary } from "../session.js";

export interface RunSessionPickerOptions {
  currentCwd: string;
  currentSessions: SessionSummary[];
  allSessions: SessionSummary[];
  resolvedTheme: ResolvedTheme;
  themeOverrides?: Record<string, string>;
}

export async function runSessionPicker(options: RunSessionPickerOptions): Promise<string | undefined> {
  const theme = paletteFor(options.resolvedTheme, options.themeOverrides);

  const renderer = await createCliRenderer();
  const root = createRoot(renderer);

  return new Promise<string | undefined>((resolve) => {
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      try { root.unmount(); } catch { /* ignore */ }
      try { renderer.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    root.render(
      <ThemeProvider value={theme}>
        <SessionPicker
          currentCwd={options.currentCwd}
          currentSessions={options.currentSessions}
          allSessions={options.allSessions}
          onSelect={(file) => finish(file)}
          onCancel={() => finish(undefined)}
        />
      </ThemeProvider>,
    );
  });
}