import chalk from "chalk";
import type { MarkdownTheme } from "@bubblebrain-ai/pi-tui";

/** Shared assistant Markdown styling for every transcript host. */
export const ASSISTANT_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => chalk.bold.cyan(text),
  link: (text) => chalk.underline.cyan(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => chalk(text),
  codeBlockBorder: (text) => chalk.cyan.dim(text),
  quote: (text) => chalk.dim(text),
  quoteBorder: (text) => chalk.cyan.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};
