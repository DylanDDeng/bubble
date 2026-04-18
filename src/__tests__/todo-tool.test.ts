import { describe, expect, it } from "vitest";
import { createTodoTool } from "../tools/todo.js";
import type { Todo } from "../types.js";

function createStore(initial: Todo[] = []) {
  let todos: Todo[] = [...initial];
  return {
    getTodos: () => todos.map((t) => ({ ...t })),
    setTodos: (next: Todo[]) => {
      todos = next.map((t) => ({ ...t }));
    },
    peek: () => todos,
  };
}

describe("todo_write tool", () => {
  it("marks itself as read-only so it is usable in plan mode", () => {
    const tool = createTodoTool(createStore());
    expect(tool.readOnly).toBe(true);
  });

  it("overwrites the prior list with the full new list", async () => {
    const store = createStore([
      { content: "a", activeForm: "doing a", status: "pending" },
      { content: "b", activeForm: "doing b", status: "pending" },
    ]);
    const tool = createTodoTool(store);
    const result = await tool.execute(
      {
        todos: [
          { content: "a", activeForm: "doing a", status: "completed" },
          { content: "c", activeForm: "doing c", status: "in_progress" },
        ],
      },
      { cwd: "/tmp" },
    );
    expect(result.isError).toBeFalsy();
    expect(store.peek()).toEqual([
      { content: "a", activeForm: "doing a", status: "completed" },
      { content: "c", activeForm: "doing c", status: "in_progress" },
    ]);
  });

  it("rejects more than one in_progress todo", async () => {
    const store = createStore();
    const tool = createTodoTool(store);
    const result = await tool.execute(
      {
        todos: [
          { content: "a", activeForm: "doing a", status: "in_progress" },
          { content: "b", activeForm: "doing b", status: "in_progress" },
        ],
      },
      { cwd: "/tmp" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("in_progress");
    expect(store.peek()).toEqual([]);
  });

  it("rejects invalid status", async () => {
    const store = createStore();
    const tool = createTodoTool(store);
    const result = await tool.execute(
      {
        todos: [{ content: "a", activeForm: "doing a", status: "done" }],
      },
      { cwd: "/tmp" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid status");
  });

  it("rejects missing content or activeForm", async () => {
    const store = createStore();
    const tool = createTodoTool(store);

    const noContent = await tool.execute(
      { todos: [{ content: "", activeForm: "x", status: "pending" }] },
      { cwd: "/tmp" },
    );
    expect(noContent.isError).toBe(true);
    expect(noContent.content).toContain("empty content");

    const noActiveForm = await tool.execute(
      { todos: [{ content: "x", activeForm: "", status: "pending" }] },
      { cwd: "/tmp" },
    );
    expect(noActiveForm.isError).toBe(true);
    expect(noActiveForm.content).toContain("empty activeForm");
  });

  it("allows clearing the list", async () => {
    const store = createStore([
      { content: "a", activeForm: "doing a", status: "completed" },
    ]);
    const tool = createTodoTool(store);
    const result = await tool.execute({ todos: [] }, { cwd: "/tmp" });
    expect(result.isError).toBeFalsy();
    expect(store.peek()).toEqual([]);
  });
});
