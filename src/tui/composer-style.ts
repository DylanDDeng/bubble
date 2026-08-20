import type { EditorOptions, EditorTheme } from "@bubblebrain-ai/pi-tui";
import chalk from "chalk";

/** Bubble's primary composer: terminal-default foreground, square box, agent prompt. */
export const COMPOSER_EDITOR_THEME: EditorTheme = {
  // No ANSI color override: on the user's dark terminal this is the requested
  // default white, and it remains readable when the terminal palette changes.
  borderColor: (str: string) => str,
  autocompleteBackground: (str: string) => chalk.bgRgb(31, 31, 31)(str),
  selectList: {
    selectedPrefix: () => chalk.cyan("› "),
    selectedText: (str: string) => str,
    selectedRow: (str: string) => chalk.bgRgb(57, 57, 57).white(str),
    description: (str: string) => chalk.dim(str),
    scrollInfo: (str: string) => chalk.dim(str),
    noMatch: (str: string) => chalk.dim(str),
  },
};

export const COMPOSER_EDITOR_OPTIONS: EditorOptions = {
  borderStyle: "box",
  paddingX: 1,
  prompt: "> ",
  autocompletePlacement: "above",
  autocompleteBorderStyle: "none",
};
