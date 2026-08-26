import chalk from "chalk";
import type { MarkdownTheme } from "@bubblebrain-ai/pi-tui";
import { darkTheme, type Theme } from "./model/theme.js";
import { themeDim, themeForeground } from "./model/theme-style.js";

/** Shared assistant Markdown styling for every transcript host. */
export function createAssistantMarkdownTheme(getTheme: () => Theme): MarkdownTheme {
  return {
    heading: (text) => chalk.bold(themeForeground(getTheme().accent, text)),
    link: (text) => chalk.underline(themeForeground(getTheme().accent, text)),
    linkUrl: (text) => themeDim(getTheme().dim, text),
    code: (text) => themeForeground(getTheme().inlineCode, text),
    codeBlock: (text) => themeForeground(getTheme().agent, text),
    codeBlockBorder: (text) => themeDim(getTheme().border, text),
    quote: (text) => themeDim(getTheme().dim, text),
    quoteBorder: (text) => themeDim(getTheme().border, text),
    hr: (text) => themeDim(getTheme().border, text),
    listBullet: (text) => themeForeground(getTheme().accent, text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };
}

export const ASSISTANT_MARKDOWN_THEME: MarkdownTheme = createAssistantMarkdownTheme(() => darkTheme);
