import { fg, StyledText } from "@opentui/core";
import type { DisplayToolCall } from "../display-history.js";
import type { ToolRenderContext, ToolRenderer } from "./types.js";

export const fallbackToolRenderer: ToolRenderer = {
  canRender: (_tool: DisplayToolCall) => true,
  render: renderFallbackTool,
};

function renderFallbackTool({ ctx, tool, syntaxStyle, width, helpers }: ToolRenderContext) {
  const { theme } = helpers;
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" ? "✎" : "●";
  const color = helpers.toolColor(tool);
  const header = helpers.toolHeader(tool);
  const diff = helpers.extractToolDiff(tool);

  if (diff && !tool.isError && tool.name === "edit") {
    return helpers.createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      helpers.createText(ctx, new StyledText([
        fg(color)(`${icon} ${helpers.displayToolName(tool.name)}`),
        fg(theme.toolText)(header ? ` ${header}` : ""),
      ])),
      helpers.createBox(ctx, {
        paddingLeft: 1,
        marginTop: 1,
        border: ["left"],
        borderColor: theme.borderSubtle,
        flexDirection: "column",
        flexShrink: 0,
      }, [helpers.createDiffRenderable(ctx, diff, helpers.toolPath(tool), syntaxStyle, width)]),
    ]);
  }

  const chunks: StyledText["chunks"] = [
    fg(color)(`${helpers.isToolFinished(tool) ? "" : "~ "}${icon} ${helpers.displayToolName(tool.name)}`),
  ];
  if (header) chunks.push(fg(theme.toolText)(` ${header}`));
  if (tool.result) {
    chunks.push(fg(theme.text)("\n"));
    chunks.push(fg(theme.borderSubtle)("  "));
    chunks.push(fg(tool.isError ? theme.toolError : theme.textMuted)(helpers.summarizeToolResult(tool)));
    const preview = helpers.toolPreview(tool);
    if (preview) {
      for (const line of preview.lines) {
        chunks.push(fg(theme.text)("\n"));
        chunks.push(fg(theme.borderSubtle)("  "));
        chunks.push(fg(theme.toolText)(line));
      }
      if (preview.omitted > 0) {
        chunks.push(fg(theme.text)("\n"));
        chunks.push(fg(theme.borderSubtle)("  "));
        chunks.push(fg(theme.textMuted)(`+ ${preview.omitted} more`));
      }
    }
  }

  return helpers.createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    helpers.createText(ctx, new StyledText(chunks), { wrapMode: "word" }),
  ]);
}
