import { describe, expect, it } from "vitest";
import { buildMarkdownThemeRules } from "../tui/markdown-theme-rules.js";

const theme = {
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#0a0a0a",
  secondary: "#5c9cf5",
  info: "#56b6c2",
  success: "#7fd88f",
  warning: "#f5a742",
  accent: "#9d7cd8",
  error: "#e06c75",
};

describe("buildMarkdownThemeRules", () => {
  it("includes markdown-specific scopes", () => {
    const rules = buildMarkdownThemeRules(theme);

    expect(rules.some((rule) => rule.scope.includes("markup.heading"))).toBe(true);
    expect(rules.some((rule) => rule.scope.includes("markup.raw.inline"))).toBe(true);
    expect(rules.some((rule) => rule.scope.includes("markup.link.url"))).toBe(true);
    expect(rules.some((rule) => rule.scope.includes("markup.strikethrough"))).toBe(true);
    expect(rules.some((rule) => rule.scope.includes("conceal"))).toBe(true);
  });

  it("maps syntax colors from the palette", () => {
    const rules = buildMarkdownThemeRules(theme);
    const keyword = rules.find((rule) => rule.scope.includes("keyword"));
    const code = rules.find((rule) => rule.scope.includes("markup.raw.block"));

    expect(keyword?.style.foreground).toBe(theme.accent);
    expect(code?.style.foreground).toBe(theme.success);
  });
});
