import type { EditorOptions, EditorTheme } from "@bubblebrain-ai/pi-tui";
import chalk from "chalk";

/** Bubble's primary composer: lightweight square box with an agent prompt. */
export const COMPOSER_EDITOR_THEME: EditorTheme = {
  // A restrained neutral plus dim makes the frame recede consistently across
  // terminal palettes while the prompt and editable text stay full-strength.
  borderColor: (str: string) => chalk.rgb(160, 160, 160).dim(str),
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
