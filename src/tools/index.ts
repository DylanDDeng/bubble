/**
 * Tool registry factory.
 */

export { createReadTool } from "./read.js";
export { createBashTool } from "./bash.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createGrepTool } from "./grep.js";
export { createWebFetchTool } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
export { createSkillTool } from "./skill.js";
export { createTodoTool, type TodoStore } from "./todo.js";
export { createExitPlanModeTool, type PlanController } from "./exit-plan-mode.js";

import type { ToolRegistryEntry } from "../types.js";
import type { ApprovalController } from "../approval/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createExitPlanModeTool, type PlanController } from "./exit-plan-mode.js";
import { createGrepTool } from "./grep.js";
import { createReadTool } from "./read.js";
import { createSkillTool } from "./skill.js";
import { createTodoTool, type TodoStore } from "./todo.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export interface CreateAllToolsOptions {
  todoStore?: TodoStore;
  planController?: PlanController;
  approvalController?: ApprovalController;
}

export function createAllTools(
  cwd: string,
  skillRegistry?: SkillRegistry,
  options: CreateAllToolsOptions = {},
): ToolRegistryEntry[] {
  const approval = options.approvalController;
  return [
    createReadTool(cwd),
    createBashTool(cwd, approval),
    createWriteTool(cwd, { refuseOverwrite: true }, approval),
    createEditTool(cwd, approval),
    createGrepTool(cwd),
    createWebSearchTool(),
    createWebFetchTool(),
    ...(skillRegistry ? [createSkillTool(skillRegistry)] : []),
    ...(options.todoStore ? [createTodoTool(options.todoStore)] : []),
    ...(options.planController ? [createExitPlanModeTool(options.planController)] : []),
  ];
}
