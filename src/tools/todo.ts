/**
 * Todo tool - manage an agent-visible task list for multi-step work.
 *
 * The tool overwrites the entire list on each call. The model should re-send the full
 * array with updated statuses rather than trying to patch individual items.
 */

import type { Todo, ToolRegistryEntry, ToolResult } from "../types.js";

export interface TodoStore {
  getTodos: () => Todo[];
  setTodos: (todos: Todo[]) => void;
}

export function createTodoTool(store: TodoStore): ToolRegistryEntry {
  return {
    name: "todo_write",
    readOnly: true,
    description:
      "Create or update the task list for the current work. Always send the COMPLETE list; this call overwrites the prior list entirely. " +
      "Use proactively for multi-step work to track progress, and mark items in_progress / completed as you work. " +
      "At most one item should be in_progress at a time.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete list of todos. Replaces any existing list.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Imperative form describing the task (e.g., 'Add unit tests for foo')",
              },
              activeForm: {
                type: "string",
                description: "Present continuous form shown while in progress (e.g., 'Adding unit tests for foo')",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current status of the task",
              },
            },
            required: ["content", "activeForm", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args): Promise<ToolResult> {
      if (!Array.isArray(args.todos)) {
        return { content: "Error: 'todos' must be an array", isError: true };
      }

      const normalized: Todo[] = [];
      for (let i = 0; i < args.todos.length; i++) {
        const raw = args.todos[i];
        if (!raw || typeof raw !== "object") {
          return { content: `Error: todo at index ${i} is not an object`, isError: true };
        }
        const content = typeof raw.content === "string" ? raw.content.trim() : "";
        const activeForm = typeof raw.activeForm === "string" ? raw.activeForm.trim() : "";
        const status = raw.status;
        if (!content) {
          return { content: `Error: todo at index ${i} has empty content`, isError: true };
        }
        if (!activeForm) {
          return { content: `Error: todo at index ${i} has empty activeForm`, isError: true };
        }
        if (status !== "pending" && status !== "in_progress" && status !== "completed") {
          return {
            content: `Error: todo at index ${i} has invalid status "${status}". Must be pending|in_progress|completed`,
            isError: true,
          };
        }
        normalized.push({ content, activeForm, status });
      }

      const inProgressCount = normalized.filter((t) => t.status === "in_progress").length;
      if (inProgressCount > 1) {
        return {
          content: `Error: at most one todo may be in_progress at a time, found ${inProgressCount}`,
          isError: true,
        };
      }

      store.setTodos(normalized);

      const counts = {
        pending: normalized.filter((t) => t.status === "pending").length,
        in_progress: inProgressCount,
        completed: normalized.filter((t) => t.status === "completed").length,
      };

      return {
        content:
          `Todo list updated: ${normalized.length} item${normalized.length === 1 ? "" : "s"} ` +
          `(${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending).`,
      };
    },
  };
}
