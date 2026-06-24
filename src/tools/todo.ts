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
    effect: "read",
    description: `Create or update the task list for the current work. Send the COMPLETE list each call; this overwrites the prior list entirely.

## When to use

Default to just doing the work. Reach for a list only when actively tracking progress would genuinely help you or the user follow it — never to pad simple work with filler steps or to state the obvious. When in doubt, skip the list and do the task; a list you never meaningfully update is just noise.

A list earns its place when:
- The task is non-trivial and spans many actions across several areas of the codebase
- There are non-obvious phases or dependencies you must hold in mind to avoid losing track (a plain read → edit → test sequence does not count)
- The work is ambiguous and benefits from outlining the goals up front
- The user asked for several distinct things in one prompt, or gave a numbered/bulleted list
- The user explicitly asked for a todo list (aka TODOs)
- You discover extra steps mid-task and intend to finish them before yielding

## Quality bar

If you do make a list, make a good one: meaningful, logically ordered steps that are easy to verify as you go.

Good — distinct, verifiable steps for genuinely multi-part work:
1. Add CSS variables for the color palette
2. Add the toggle with localStorage state
3. Refactor components to use the variables
4. Verify every view for readability

Good — scope a search uncovers makes the list worth it:
"Rename getCwd across the project" → grep finds 15 call sites in 8 files → one item per file so none are missed.

Bad — padding a task you could just do; do NOT create a list for this:
"Fix the typo in the README title" → 1. Find typo  2. Open file  3. Fix it  4. Save. That is one edit — just make it.

Bad — vague, unverifiable filler: "Make it work", "Improve the styling", "Clean things up".

## Task states

- pending: not yet started
- in_progress: currently working on — exactly ONE at a time
- completed: finished successfully

Each item needs:
- content: imperative form (e.g. "Run tests")
- activeForm: present continuous, shown while in progress (e.g. "Running tests")

## Rules

- Update status in real time; mark completed IMMEDIATELY on finishing.
- Never mark completed if tests are failing, implementation is partial, errors are unresolved, or needed files are missing — keep as in_progress.
- When blocked, add a new task describing what must be resolved.
- Remove items that are no longer relevant; don't leave stale entries.
- Do not re-send the list when nothing meaningful has changed since the last call; update only after real progress.`,
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
