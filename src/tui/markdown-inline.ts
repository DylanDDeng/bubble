export interface MarkdownInlineSegment {
  text: string;
  color?: "text" | "textMuted" | "success" | "warning" | "secondary";
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}

type InlineToken = {
  type?: string;
  text?: string;
  raw?: string;
  href?: string;
  tokens?: InlineToken[];
};

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  color?: MarkdownInlineSegment["color"];
}

export function markdownInlineSegments(
  tokens: InlineToken[] | undefined,
  fallback = "",
  style: InlineStyle = {},
): MarkdownInlineSegment[] {
  const segments: MarkdownInlineSegment[] = [];
  for (const token of tokens ?? []) {
    appendInlineToken(segments, token, style);
  }
  if (segments.length === 0 && fallback) {
    appendStyled(segments, fallback, style);
  }
  return segments;
}

function appendInlineToken(
  segments: MarkdownInlineSegment[],
  token: InlineToken,
  style: InlineStyle,
) {
  switch (token.type) {
    case "strong":
      appendInlineTokens(segments, token.tokens, { ...style, bold: true });
      return;
    case "em":
      appendInlineTokens(segments, token.tokens, { ...style, italic: true, color: style.color ?? "warning" });
      return;
    case "del":
      appendInlineTokens(segments, token.tokens, { ...style, dim: true, color: style.color ?? "textMuted" });
      return;
    case "codespan":
      appendStyled(segments, token.text ?? "", { ...style, color: "success" });
      return;
    case "link":
      appendInlineTokens(segments, token.tokens, { ...style, color: style.color ?? "secondary" });
      return;
    case "br":
      appendStyled(segments, "\n", style);
      return;
    case "text":
    case "paragraph":
    case "list_item":
    case "heading":
      if (token.tokens?.length) {
        appendInlineTokens(segments, token.tokens, style);
      } else {
        appendStyled(segments, token.text ?? token.raw ?? "", style);
      }
      return;
    case "space":
      return;
    default:
      if (token.tokens?.length) {
        appendInlineTokens(segments, token.tokens, style);
      } else {
        appendStyled(segments, token.text ?? token.raw ?? "", style);
      }
  }
}

function appendInlineTokens(
  segments: MarkdownInlineSegment[],
  tokens: InlineToken[] | undefined,
  style: InlineStyle,
) {
  for (const child of tokens ?? []) {
    appendInlineToken(segments, child, style);
  }
}

function appendStyled(
  segments: MarkdownInlineSegment[],
  text: string,
  style: InlineStyle,
) {
  if (!text) return;
  segments.push({
    text,
    color: style.color ?? "text",
    bold: style.bold,
    italic: style.italic,
    dim: style.dim,
  });
}
