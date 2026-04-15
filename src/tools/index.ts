/**
 * Tool registry factory.
 */

export { createReadTool } from "./read.js";
export { createBashTool } from "./bash.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createGrepTool } from "./grep.js";
export { createLsTool } from "./ls.js";
export { createWebSearchTool } from "./web-search.js";

import type { ToolRegistryEntry } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export function createAllTools(cwd: string): ToolRegistryEntry[] {
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createWriteTool(cwd, { refuseOverwrite: true }),
    createEditTool(cwd),
    createGrepTool(cwd),
    createLsTool(cwd),
    createWebSearchTool(),
  ];
}
