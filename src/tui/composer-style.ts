import type { EditorOptions, EditorTheme } from "@bubblebrain-ai/pi-tui";
import { darkTheme, type Theme } from "./model/theme.js";
import { themeBackground, themeDim, themeForeground } from "./model/theme-style.js";

/** Bubble's primary composer: lightweight square box with an agent prompt. */
export function createComposerEditorTheme(getTheme: () => Theme): EditorTheme {
  return {
    // The callbacks read the current palette on every render. Editor keeps the
    // theme object for its lifetime, so this is what makes /theme repaint an
    // already-mounted composer and autocomplete menu without reconstruction.
    borderColor: (str: string) => themeDim(getTheme().border, str),
    autocompleteBackground: (str: string) => themeBackground(getTheme().backgroundPanel, str),
    selectList: {
      selectedPrefix: () => themeForeground(getTheme().accent, "› "),
      selectedText: (str: string) => themeForeground(getTheme().inputText, str),
      selectedRow: (str: string) => themeForeground(
        getTheme().inputText,
        themeBackground(getTheme().traceSelectedBg, str),
      ),
      description: (str: string) => themeDim(getTheme().dim, str),
      scrollInfo: (str: string) => themeDim(getTheme().dim, str),
      noMatch: (str: string) => themeDim(getTheme().dim, str),
    },
  };
}

/** Backward-compatible dark default for isolated components and tests. */
export const COMPOSER_EDITOR_THEME: EditorTheme = createComposerEditorTheme(() => darkTheme);

export const COMPOSER_EDITOR_OPTIONS: EditorOptions = {
  borderStyle: "box",
  paddingX: 1,
  prompt: "> ",
  autocompletePlacement: "above",
  autocompleteBorderStyle: "none",
};
