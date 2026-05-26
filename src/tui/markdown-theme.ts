import { SyntaxStyle } from "@opentui/core";
import { buildMarkdownThemeRules, type MarkdownThemePalette } from "./markdown-theme-rules.js";

export type { MarkdownThemePalette } from "./markdown-theme-rules.js";

export function createMarkdownSyntaxStyle(theme: MarkdownThemePalette): SyntaxStyle {
  return SyntaxStyle.fromTheme(buildMarkdownThemeRules(theme));
}

export function createSubtleMarkdownSyntaxStyle(theme: MarkdownThemePalette, opacity = 0.6): SyntaxStyle {
  const alpha = Math.max(0, Math.min(1, opacity));
  return SyntaxStyle.fromTheme(
    buildMarkdownThemeRules(theme).map((rule) => ({
      ...rule,
      style: {
        ...rule.style,
        foreground: rule.style.foreground
          ? applyAlpha(rule.style.foreground, alpha)
          : rule.style.foreground,
      },
    })),
  );
}

function applyAlpha(color: string, opacity: number): string {
  if (!color.startsWith("#")) return color;
  const hex = color.slice(1);
  if (hex.length !== 6 && hex.length !== 8) return color;
  const rgb = hex.slice(0, 6);
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return `#${rgb}${alpha}`;
}
