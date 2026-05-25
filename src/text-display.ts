import stringWidth from "string-width";

export function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateVisual(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  let out = "";
  let width = 0;
  for (const ch of text) {
    const chWidth = stringWidth(ch);
    if (width + chWidth > maxWidth - 1) break;
    out += ch;
    width += chWidth;
  }
  return `${out}…`;
}

export function padVisual(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}`;
}
