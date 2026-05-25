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
export { createSkillSearchTool } from "./skill-search.js";
export { createAgentLifecycleTools, createCloseAgentTool, createSendInputTool, createSpawnAgentTool, createWaitAgentTool } from "./agent-lifecycle.js";
export { createTodoTool, type TodoStore } from "./todo.js";
export { createExitPlanModeTool, type PlanController } from "./exit-plan-mode.js";
export { createToolSearchTool, type ToolSearchController } from "./tool-search.js";
export { createQuestionTool } from "./question.js";
export { createMemoryReadSummaryTool, createMemorySearchTool } from "./memory.js";

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
import { createSkillSearchTool } from "./skill-search.js";
import { createAgentLifecycleTools } from "./agent-lifecycle.js";
import { createTodoTool, type TodoStore } from "./todo.js";
import { createToolSearchTool, type ToolSearchController } from "./tool-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";
import { createQuestionTool } from "./question.js";
import { createMemoryReadSummaryTool, createMemorySearchTool } from "./memory.js";
import type { QuestionController } from "../question/index.js";
import { FileStateTracker } from "./file-state.js";

export interface CreateAllToolsOptions {
  todoStore?: TodoStore;
  planController?: PlanController;
  approvalController?: ApprovalController;
  questionController?: QuestionController;
  toolSearchController?: ToolSearchController;
  lspService?: LspService;
  fileStateTracker?: FileStateTracker;
}

export function createAllTools(
  cwd: string,
  skillRegistry?: SkillRegistry,
  options: CreateAllToolsOptions = {},
): ToolRegistryEntry[] {
  const approval = options.approvalController;
  const lsp = options.lspService ?? getLspService(cwd);
  const fileState = options.fileStateTracker ?? new FileStateTracker(cwd);
  return [
    createReadTool(cwd, approval, lsp, fileState),
    createBashTool(cwd, approval, fileState),
    createWriteTool(cwd, { refuseOverwrite: true }, approval, lsp, fileState),
    createEditTool(cwd, approval, lsp, fileState),
    createGlobTool(cwd),
    createGrepTool(cwd),
    createLspTool(cwd, lsp, approval),
    createWebSearchTool(),
    createWebFetchTool(approval),
    createMemorySearchTool(cwd),
    createMemoryReadSummaryTool(cwd),
    ...createAgentLifecycleTools(),
    ...(options.questionController ? [createQuestionTool(options.questionController)] : []),
    ...(skillRegistry ? [createSkillSearchTool(skillRegistry), createSkillTool(skillRegistry)] : []),
    ...(options.todoStore ? [createTodoTool(options.todoStore)] : []),
    ...(options.planController ? [createExitPlanModeTool(options.planController)] : []),
    ...(options.toolSearchController ? [createToolSearchTool(options.toolSearchController)] : []),
  ];
}
