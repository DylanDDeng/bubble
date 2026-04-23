import { SyntaxStyle } from "@opentui/core";
import { buildMarkdownThemeRules, type MarkdownThemePalette } from "./markdown-theme-rules.js";

export type { MarkdownThemePalette } from "./markdown-theme-rules.js";

export function createMarkdownSyntaxStyle(theme: MarkdownThemePalette): SyntaxStyle {
  return SyntaxStyle.fromTheme(buildMarkdownThemeRules(theme));
}
