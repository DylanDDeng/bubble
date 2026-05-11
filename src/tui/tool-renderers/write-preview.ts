import type { DisplayToolCall } from "../display-history.js";

const WRITE_PREVIEW_LINE_LIMIT = 10;
export const WRITE_PREVIEW_CHAR_LIMIT = 5000;

export function isWritePreviewTool(tool: DisplayToolCall): tool is DisplayToolCall & { args: { content: string } } {
  return !tool.isError && tool.name === "write" && typeof tool.args?.content === "string";
}

export function formatWritePreview(content: string, expanded: boolean) {
  const lines = content.split(/\r?\n/);
  if (expanded) {
    return { content, omittedLines: 0, omittedChars: 0 };
  }

  let previewContent = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT).join("\n");
  let omittedLines = Math.max(0, lines.length - WRITE_PREVIEW_LINE_LIMIT);

  if (previewContent.length > WRITE_PREVIEW_CHAR_LIMIT) {
    previewContent = previewContent.slice(0, WRITE_PREVIEW_CHAR_LIMIT);
    omittedLines = Math.max(omittedLines, lines.length - previewContent.split(/\r?\n/).length);
  }

  return {
    content: previewContent,
    omittedLines,
    omittedChars: Math.max(0, content.length - previewContent.length),
  };
}

export function parsePartialWriteArgs(rawArguments: string): Record<string, unknown> {
  const path = extractPartialJsonStringField(rawArguments, "path");
  const content = extractPartialJsonStringField(rawArguments, "content");
  return {
    ...(path !== undefined ? { path } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

function extractPartialJsonStringField(raw: string, field: string): string | undefined {
  const keyIndex = raw.indexOf(JSON.stringify(field));
  if (keyIndex === -1) return undefined;
  const colonIndex = raw.indexOf(":", keyIndex + field.length + 2);
  if (colonIndex === -1) return undefined;
  let index = colonIndex + 1;
  while (index < raw.length && /\s/.test(raw[index] ?? "")) index++;
  if (raw[index] !== "\"") return undefined;
  index++;

  let value = "";
  while (index < raw.length) {
    const char = raw[index++];
    if (char === "\"") return value;
    if (char !== "\\") {
      value += char;
      continue;
    }
    if (index >= raw.length) return value;
    const escaped = raw[index++];
    switch (escaped) {
      case "\"":
      case "\\":
      case "/":
        value += escaped;
        break;
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "u": {
        const hex = raw.slice(index, index + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        }
        break;
      }
      default:
        value += escaped;
        break;
    }
  }
  return value;
}
