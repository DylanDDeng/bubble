/**
 * Tool registry factory.
 */

export { createReadTool } from "./read.js";
export { createBashTool } from "./bash.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createGlobTool } from "./glob.js";
export { createGrepTool } from "./grep.js";
export { createLspTool } from "./lsp.js";
export { createWebFetchTool } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
export { createSkillTool } from "./skill.js";
export { createTaskTool } from "./task.js";
export { createTodoTool, type TodoStore } from "./todo.js";
export { createExitPlanModeTool, type PlanController } from "./exit-plan-mode.js";
export { createToolSearchTool, type ToolSearchController } from "./tool-search.js";

import type { ToolRegistryEntry } from "../types.js";
import type { ApprovalController } from "../approval/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createExitPlanModeTool, type PlanController } from "./exit-plan-mode.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { getLspService, type LspService } from "../lsp/index.js";
import { createLspTool } from "./lsp.js";
import { createReadTool } from "./read.js";
import { createSkillTool } from "./skill.js";
import { createTaskTool } from "./task.js";
import { createTodoTool, type TodoStore } from "./todo.js";
import { createToolSearchTool, type ToolSearchController } from "./tool-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export interface CreateAllToolsOptions {
  todoStore?: TodoStore;
  planController?: PlanController;
  approvalController?: ApprovalController;
  toolSearchController?: ToolSearchController;
  lspService?: LspService;
}

export function createAllTools(
  cwd: string,
  skillRegistry?: SkillRegistry,
  options: CreateAllToolsOptions = {},
): ToolRegistryEntry[] {
  const approval = options.approvalController;
  const lsp = options.lspService ?? getLspService(cwd);
  return [
    createReadTool(cwd, approval, lsp),
    createBashTool(cwd, approval),
    createWriteTool(cwd, { refuseOverwrite: true }, approval, lsp),
    createEditTool(cwd, approval, lsp),
    createGlobTool(cwd),
    createGrepTool(cwd),
    createLspTool(cwd, lsp, approval),
    createWebSearchTool(),
    createWebFetchTool(approval),
    createTaskTool(),
    ...(skillRegistry ? [createSkillTool(skillRegistry)] : []),
    ...(options.todoStore ? [createTodoTool(options.todoStore)] : []),
    ...(options.planController ? [createExitPlanModeTool(options.planController)] : []),
    ...(options.toolSearchController ? [createToolSearchTool(options.toolSearchController)] : []),
  ];
}
