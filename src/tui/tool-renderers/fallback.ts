import { fg, StyledText } from "@opentui/core";
import type { DisplayToolCall } from "../display-history.js";
import type { ToolRenderContext, ToolRenderer } from "./types.js";

export const fallbackToolRenderer: ToolRenderer = {
  canRender: (_tool: DisplayToolCall) => true,
  render: renderFallbackTool,
};

function renderFallbackTool({ ctx, tool, syntaxStyle, width, helpers }: ToolRenderContext) {
  const { theme } = helpers;
  const icon = helpers.toolStateIcon(tool);
  const color = helpers.toolColor(tool);
  const header = helpers.toolHeader(tool);
  const diff = helpers.extractToolDiff(tool);
  const isError = tool.isError === true || tool.status === "error";

  if (diff && !isError && (tool.name === "edit" || tool.name === "apply_patch")) {
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
    fg(color)(`${icon} ${helpers.displayToolName(tool.name)}`),
  ];
  if (header) chunks.push(fg(theme.toolText)(` ${header}`));
  const showTail = !!tool.result || tool.status === "running" || tool.status === "pending" || tool.streamingArgs === true;
  if (showTail) {
    const summary = helpers.summarizeToolResult(tool);
    if (summary) {
      chunks.push(fg(theme.text)("\n"));
      chunks.push(fg(theme.borderSubtle)("  "));
      chunks.push(fg(isError ? theme.toolError : theme.textMuted)(summary));
    }
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

  const containerProps: Record<string, unknown> = {
    paddingLeft: isError ? 1 : 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  };
  if (isError) {
    containerProps.border = ["left"];
    containerProps.borderColor = theme.toolError;
    containerProps.paddingLeft = 2;
  }

  return helpers.createBox(ctx, containerProps, [
    helpers.createText(ctx, new StyledText(chunks), { wrapMode: "word" }),
  ]);
}
