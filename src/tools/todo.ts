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
    description: `Create or update the task list for the current work. Send the COMPLETE list each call; this overwrites the prior list entirely.

## When to use

Use this tool proactively when any of these apply:
1. Complex multi-step work — 3 or more distinct steps or file locations
2. Non-trivial tasks requiring planning or coordination across multiple operations
3. The user explicitly asks for a todo list
4. The user provides a list of things to do (numbered, comma-separated, bulleted)
5. New instructions arrive mid-session — capture them as todos before starting
6. Starting work on a task — mark it in_progress BEFORE beginning. Only one item may be in_progress at a time
7. Finishing a task — mark it completed immediately, don't batch completions

## When NOT to use

Skip this tool when:
1. There is a single, straightforward task
2. The task is trivial and tracking provides no organizational benefit
3. The work can be completed in fewer than 3 trivial steps
4. The request is purely conversational or informational

If there is only one trivial task, just do it — don't create a todo first.

## Examples

<example>
User: Add a dark mode toggle to the settings page, then run tests and build.
Assistant: *creates a 5-item todo: toggle UI, theme state, CSS tokens, update components, run tests + build*
<reasoning>Multiple distinct steps across UI, state, styles, and verification. User explicitly asked for tests + build.</reasoning>
</example>

<example>
User: Rename getCwd to getCurrentWorkingDirectory across the project.
Assistant: *greps, finds 15 call sites across 8 files, creates a per-file todo list*
<reasoning>Scope discovered via grep shows many locations; a todo ensures each file is tracked and none are missed.</reasoning>
</example>

<example>
User: How do I print "Hello World" in Python?
Assistant: *answers in one sentence with a snippet — no todo*
<reasoning>Informational, one-step, no tracking benefit.</reasoning>
</example>

<example>
User: Add a comment to calculateTotal explaining what it does.
Assistant: *calls edit directly — no todo*
<reasoning>Single, localized change in one file.</reasoning>
</example>

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
- Remove items that are no longer relevant; don't leave stale entries.`,
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
