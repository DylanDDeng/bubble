/**
 * Tool registry factory.
 */

export { createReadTool } from "./read.js";
export { createBashTool } from "./bash.js";
export { createManagedServerTools } from "./server.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { buildToolPromptOptions } from "./prompt-metadata.js";
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
export { createMemoryTool } from "./memory.js";

import type { ToolRegistryEntry } from "../types.js";
import type { ApprovalController } from "../approval/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createBashTool } from "./bash.js";
import { createManagedServerTools } from "./server.js";
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
import { createMemoryTool } from "./memory.js";
import type { QuestionController } from "../question/index.js";
import type { CheckpointStore } from "../checkpoints.js";
import { FileStateTracker } from "./file-state.js";
import { createGoalTools } from "../goal/tools.js";
import type { GoalStore } from "../goal/store.js";
import { createBackgroundTaskTools } from "./task-tools.js";
import type { ProcessManager } from "../tasks/manager.js";
import type { PromotionChannel } from "../tasks/promotion.js";

export interface CreateAllToolsOptions {
  todoStore?: TodoStore;
  planController?: PlanController;
  approvalController?: ApprovalController;
  questionController?: QuestionController;
  toolSearchController?: ToolSearchController;
  lspService?: LspService;
  fileStateTracker?: FileStateTracker;
  /**
   * Lazy accessor for the session's checkpoint store (the session manager may
   * not exist yet when tools are created). Used by edit/write to snapshot
   * files before mutating them so /rewind can restore.
   */
  checkpoints?: () => CheckpointStore | undefined;
  /** Shared goal state; when present, registers the update_goal tool. */
  goalStore?: GoalStore;
  /**
   * Unified process manager (background tasks + managed servers). Background
   * tasks are a per-host capability (background-tasks design §2.0): pass the
   * manager AND set allowBackgroundTasks only in hosts that wire the full
   * completion story (currently the interactive TUI). Without it, bash
   * rejects run_in_background and the task tools are not registered.
   */
  processManager?: ProcessManager;
  allowBackgroundTasks?: boolean;
  /** Ctrl+G send-to-background requests from the TUI (design §2.5). */
  promotionChannel?: PromotionChannel;
}

export function createAllTools(
  cwd: string,
  skillRegistry?: SkillRegistry,
  options: CreateAllToolsOptions = {},
): ToolRegistryEntry[] {
  const approval = options.approvalController;
  const lsp = options.lspService ?? getLspService(cwd);
  const fileState = options.fileStateTracker ?? new FileStateTracker(cwd);
  const backgroundTasks = options.allowBackgroundTasks === true && !!options.processManager;
  return [
    createReadTool(cwd, approval, lsp, fileState),
    createBashTool(cwd, approval, fileState, {
      processManager: options.processManager,
      allowBackgroundTasks: backgroundTasks,
      promotionChannel: backgroundTasks ? options.promotionChannel : undefined,
    }),
    ...(backgroundTasks ? createBackgroundTaskTools(options.processManager!) : []),
    ...createManagedServerTools(cwd, approval),
    createWriteTool(cwd, {}, approval, lsp, fileState, options.checkpoints),
    createEditTool(cwd, approval, lsp, fileState, options.checkpoints),
    createGlobTool(cwd),
    createGrepTool(cwd),
    createLspTool(cwd, lsp, approval),
    createWebSearchTool(),
    createWebFetchTool(approval),
    createMemoryTool(cwd),
    ...createAgentLifecycleTools({ cwd, approval }),
    // Always registered: any host can carry deferred tools (MCP entries mark
    // themselves deferred), so every host needs the unlock path. Falls back
    // to the executing agent when no controller is wired.
    createToolSearchTool(options.toolSearchController),
    ...(options.questionController ? [createQuestionTool(options.questionController)] : []),
    ...(skillRegistry ? [createSkillSearchTool(skillRegistry), createSkillTool(skillRegistry)] : []),
    ...(options.todoStore ? [createTodoTool(options.todoStore)] : []),
    ...(options.planController ? [createExitPlanModeTool(options.planController)] : []),
    ...(options.goalStore ? createGoalTools(options.goalStore) : []),
  ];
}
