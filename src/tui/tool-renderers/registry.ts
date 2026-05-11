import type { DisplayToolCall } from "../display-history.js";
import type { ToolRenderer } from "./types.js";
import { fallbackToolRenderer } from "./fallback.js";
import { writeToolRenderer } from "./write.js";

const TOOL_RENDERERS: ToolRenderer[] = [
  writeToolRenderer,
  fallbackToolRenderer,
];

export function findToolRenderer(tool: DisplayToolCall): ToolRenderer | undefined {
  return TOOL_RENDERERS.find((renderer) => renderer.canRender(tool));
}
