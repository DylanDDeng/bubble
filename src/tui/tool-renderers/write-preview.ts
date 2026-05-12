import type { DisplayToolCall } from "../display-history.js";

const WRITE_PREVIEW_LINE_LIMIT = 10;
export const WRITE_PREVIEW_CHAR_LIMIT = 5000;

export function isWritePreviewTool(tool: DisplayToolCall): tool is DisplayToolCall & { args: { content?: string } } {
  if (tool.isError) return false;
  if (tool.name !== "write") return false;
  if (typeof tool.args?.content === "string") return true;
  // While the model is still streaming the JSON args, content may not be
  // populated yet — keep ownership so the header renders progressively.
  return tool.streamingArgs === true;
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
