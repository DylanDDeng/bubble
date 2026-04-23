export interface MarkdownThemePalette {
  text: string;
  textMuted: string;
  background: string;
  secondary: string;
  info: string;
  success: string;
  warning: string;
  accent: string;
  error: string;
}

export interface SyntaxThemeRule {
  scope: string[];
  style: {
    foreground?: string;
    background?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
  };
}

export function buildMarkdownThemeRules(theme: MarkdownThemePalette): SyntaxThemeRule[] {
  return [
    {
      scope: ["default"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["comment", "comment.documentation"],
      style: {
        foreground: theme.textMuted,
        italic: true,
      },
    },
    {
      scope: ["string", "symbol", "character", "character.special", "string.escape"],
      style: {
        foreground: theme.success,
      },
    },
    {
      scope: ["number", "boolean", "constant", "float"],
      style: {
        foreground: theme.warning,
      },
    },
    {
      scope: [
        "keyword",
        "keyword.import",
        "keyword.return",
        "keyword.conditional",
        "keyword.repeat",
        "keyword.coroutine",
        "keyword.directive",
        "keyword.modifier",
        "keyword.exception",
        "string.regexp",
      ],
      style: {
        foreground: theme.accent,
        italic: true,
      },
    },
    {
      scope: ["keyword.type", "type", "class", "module"],
      style: {
        foreground: theme.info,
        bold: true,
      },
    },
    {
      scope: ["function", "function.call", "function.method", "function.method.call", "constructor"],
      style: {
        foreground: theme.secondary,
      },
    },
    {
      scope: ["variable", "variable.parameter", "variable.member", "property", "parameter"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter", "punctuation.special"],
      style: {
        foreground: theme.info,
      },
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
      style: {
        foreground: theme.text,
        bold: true,
      },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: {
        foreground: theme.text,
        bold: true,
      },
    },
    {
      scope: ["markup.italic"],
      style: {
        foreground: theme.warning,
        italic: true,
      },
    },
    {
      scope: ["markup.strikethrough"],
      style: {
        foreground: theme.textMuted,
        dim: true,
      },
    },
    {
      scope: ["markup.list"],
      style: {
        foreground: theme.secondary,
      },
    },
    {
      scope: ["markup.quote"],
      style: {
        foreground: theme.warning,
        italic: true,
      },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.success,
      },
    },
    {
      scope: ["markup.raw.inline"],
      style: {
        foreground: theme.success,
        background: theme.background,
      },
    },
    {
      scope: ["markup.link", "markup.link.url", "string.special.url"],
      style: {
        foreground: theme.secondary,
        underline: true,
      },
    },
    {
      scope: ["markup.link.label", "label"],
      style: {
        foreground: theme.info,
        underline: true,
      },
    },
    {
      scope: ["spell", "nospell"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["conceal"],
      style: {
        foreground: theme.textMuted,
      },
    },
  ];
}
