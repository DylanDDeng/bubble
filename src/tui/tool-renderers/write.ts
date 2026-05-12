import { fg, StyledText } from "@opentui/core";
import type { DisplayMessage, DisplayToolCall } from "../display-history.js";
import { hashString } from "../render-signature.js";
import type { ToolRenderContext, ToolRenderer } from "./types.js";
import { formatWritePreview, isWritePreviewTool, WRITE_PREVIEW_CHAR_LIMIT } from "./write-preview.js";

export const writeToolRenderer: ToolRenderer = {
  canRender: isWritePreviewTool,
  expansionKey: writeToolKey,
  signature: writeToolExpansionSignature,
  render: renderWriteTool,
};

export function writeToolKey(messageKey: string, tool: DisplayToolCall) {
  return `${messageKey}:write:${tool.id}`;
}

export function writeToolExpansionDigest(message: DisplayMessage, messageKey: string, expandedWrites: Set<string>) {
  return (message.toolCalls ?? [])
    .filter((tool) => isWritePreviewTool(tool))
    .map((tool) => writeToolExpansionSignature(messageKey, tool, expandedWrites))
    .join("|");
}

export function writeToolExpansionSignature(messageKey: string, tool: DisplayToolCall, expandedWrites: Set<string>) {
  if (!isWritePreviewTool(tool)) return "";
  const content = typeof tool.args.content === "string" ? tool.args.content : "";
  return [
    tool.id,
    expandedWrites.has(writeToolKey(messageKey, tool)) ? "expanded" : "collapsed",
    content.length,
    content.split(/\r?\n/).length,
    hashString(content.slice(0, WRITE_PREVIEW_CHAR_LIMIT)),
    hashString(content.slice(-WRITE_PREVIEW_CHAR_LIMIT)),
  ].join(":");
}

function renderWriteTool({ ctx, tool, syntaxStyle, writeExpanded, onToggleWrite, helpers }: ToolRenderContext) {
  const { theme } = helpers;
  const color = helpers.toolColor(tool);
  const icon = "●";
  const header = helpers.toolHeader(tool);
  const hasContent = typeof tool.args.content === "string";
  const contentStr = hasContent ? String(tool.args.content) : "";
  const preview = hasContent ? formatWritePreview(contentStr, writeExpanded) : null;
  const writeLineCount = hasContent
    ? contentStr.split(/\r?\n/).length
    : (tool.streamingNewlineCount ?? 0) + 1;
  const summary = tool.result
    ? helpers.summarizeToolResult(tool)
    : `${helpers.isToolFinished(tool) ? "Prepared" : "Writing"} ${writeLineCount} line${writeLineCount === 1 ? "" : "s"} to ${helpers.toolPath(tool) ?? "file"}`;
  const hint = preview && preview.omittedLines > 0
    ? `... +${preview.omittedLines} lines (${writeExpanded ? "ctrl+o to collapse" : "ctrl+o to expand"})`
    : preview && preview.omittedChars > 0
      ? `... +${preview.omittedChars} chars (${writeExpanded ? "ctrl+o to collapse" : "ctrl+o to expand"})`
      : preview && writeExpanded
        ? "(ctrl+o to collapse)"
        : "";

  return helpers.createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    helpers.createText(ctx, new StyledText([
      fg(color)(`${icon} ${helpers.displayToolName(tool.name)}`),
      fg(theme.toolText)(header ? ` ${header}` : ""),
    ]), {
      onMouseUp: onToggleWrite,
    }),
    helpers.createBox(ctx, {
      paddingLeft: 1,
      marginTop: 0,
      border: ["left"],
      borderColor: theme.borderSubtle,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      helpers.createText(ctx, `└ ${summary}`, {
        fg: tool.isError ? theme.toolError : theme.textMuted,
        onMouseUp: onToggleWrite,
      }),
      preview
        ? helpers.createCodeBlockRenderable(ctx, preview.content, helpers.toolPath(tool), syntaxStyle)
        : null,
      hint
        ? helpers.createText(ctx, hint, {
          fg: theme.textMuted,
          onMouseUp: onToggleWrite,
        })
        : null,
    ]),
  ]);
}
