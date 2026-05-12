import type { RenderContext, Renderable, StyledText, SyntaxStyle, TextRenderable } from "@opentui/core";
import type { DisplayToolCall } from "../display-history.js";

export interface ToolRenderer {
  canRender(tool: DisplayToolCall): boolean;
  expansionKey?(messageKey: string, tool: DisplayToolCall): string | undefined;
  signature?(messageKey: string, tool: DisplayToolCall, expandedWrites: Set<string>): string;
  render(context: ToolRenderContext): Renderable;
}

export interface ToolRenderContext {
  ctx: RenderContext;
  tool: DisplayToolCall;
  syntaxStyle: SyntaxStyle;
  width: number;
  writeExpanded: boolean;
  onToggleWrite?: () => void;
  helpers: ToolRenderHelpers;
}

export interface ToolRenderHelpers {
  theme: Record<string, string>;
  createBox: (ctx: RenderContext, options: Record<string, unknown>, children?: Array<Renderable | null | undefined>) => Renderable;
  createText: (ctx: RenderContext, content: string | StyledText, options?: Record<string, unknown>) => TextRenderable;
  createCodeBlockRenderable: (ctx: RenderContext, content: string, filePath: string | undefined, syntaxStyle: SyntaxStyle) => Renderable;
  createDiffRenderable: (ctx: RenderContext, diff: string, filePath: string | undefined, syntaxStyle: SyntaxStyle, width?: number) => Renderable;
  toolColor: (tool: DisplayToolCall) => string;
  displayToolName: (name: string) => string;
  toolHeader: (tool: DisplayToolCall) => string;
  toolPath: (tool: DisplayToolCall) => string | undefined;
  extractToolDiff: (tool: DisplayToolCall) => string | undefined;
  summarizeToolResult: (tool: DisplayToolCall) => string;
  isToolFinished: (tool: DisplayToolCall) => boolean;
  toolPreview: (tool: DisplayToolCall) => { lines: string[]; omitted: number } | undefined;
  toolStateIcon: (tool: DisplayToolCall) => string;
}
