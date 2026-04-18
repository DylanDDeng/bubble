import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

function createMockProvider(chunks: StreamChunk[][]): Provider {
  let callIndex = 0;
  return {
    async *streamChat(_messages, _options) {
      const current = chunks[callIndex++] || [];
      for (const chunk of current) {
        yield chunk;
      }
    },
    async complete(messages, options) {
      return "mock completion";
    },
  };
}

function collectEvents(agent: Agent, input: string, cwd: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  return (async () => {
    for await (const event of agent.run(input, cwd)) {
      events.push(event);
    }
    return events;
  })();
}

describe("Agent", () => {
  const dummyTool: ToolRegistryEntry = {
    name: "dummy",
    description: "A dummy tool",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    async execute(args) {
      return { content: `result: ${args.value}` };
    },
  };

  it("handles a simple text response", async () => {
    const provider = createMockProvider([
      [{ type: "text", content: "Hello!" }, { type: "done" }],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    expect(events.some((e) => e.type === "text_delta" && e.content === "Hello!")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
    expect(agent.messages).toHaveLength(2); // user + assistant (no system prompt in this test)
  });

  it("auto-continues after a tool call", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        {
          type: "tool_call",
          id: "tc_1",
          name: "dummy",
          arguments: '{"value":"42"}',
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Call dummy", "/tmp");

    expect(events.some((e) => e.type === "tool_start" && e.name === "dummy")).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.result.content === "result: 42")).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.content === "Done!")).toBe(true);
    expect(agent.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("reports unknown tool error", async () => {
    const provider = createMockProvider([
      [
        {
          type: "tool_call",
          id: "tc_1",
          name: "nonexistent",
          arguments: "{}",
          isStart: true,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "Sorry" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Test", "/tmp");

    const toolEnd = events.find((e) => e.type === "tool_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content).toContain("Unknown tool");
  });

  it("calls onMessageAppend for each message", async () => {
    const appended: Message[] = [];
    const provider = createMockProvider([
      [{ type: "text", content: "ok" }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      onMessageAppend: (m) => appended.push(m),
    });

    await collectEvents(agent, "Hi", "/tmp");
    expect(appended.some((m) => m.role === "user")).toBe(true);
    expect(appended.some((m) => m.role === "assistant")).toBe(true);
  });

  it("calls onToolResult when a tool finishes successfully", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        {
          type: "tool_call",
          id: "tc_1",
          name: "dummy",
          arguments: '{"value":"42"}',
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const seen: Array<{ toolName: string; content: string }> = [];
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [dummyTool],
      onToolResult: (toolName, result) => {
        seen.push({ toolName, content: result.content });
      },
    });

    await collectEvents(agent, "Call dummy", "/tmp");
    expect(seen).toEqual([{ toolName: "dummy", content: "result: 42" }]);
  });

  it("projects messages before sending them to the provider", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        captured.push(messages);
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      systemPrompt: "system-1",
    });

    agent.messages.unshift({ role: "system", content: "system-0" });
    agent.messages.push({ role: "assistant", content: "" });

    await collectEvents(agent, "Hi", "/tmp");

    expect(captured).toHaveLength(1);
    expect(captured[0][0].role).toBe("system");
    expect((captured[0][0] as any).content).toContain("system-0");
    expect((captured[0][0] as any).content).toContain("system-1");
    expect(captured[0].some((message) => message.role === "assistant" && message.content === "")).toBe(false);
  });

  it("auto-compacts oversized history before sending it to the provider", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        captured.push(messages);
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [],
      systemPrompt: "system",
    });

    for (let i = 0; i < 5; i++) {
      agent.messages.push({ role: "user", content: `turn ${i} ` + "x".repeat(120000) });
      agent.messages.push({ role: "assistant", content: `reply ${i}` });
    }

    await collectEvents(agent, "latest turn", "/tmp");

    expect(captured).toHaveLength(1);
    const systemMessages = captured[0].filter((message) => message.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    expect(systemMessages.some((message) => message.content.includes("Previous conversation summary:"))).toBe(true);
  });

  it("rethrows non-overflow errors without retry", async () => {
    let callCount = 0;
    const provider: Provider = {
      async *streamChat() {
        callCount += 1;
        throw new Error("401 Invalid Authentication");
      },
      async complete() {
        return "";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    await expect(collectEvents(agent, "hi", "/tmp")).rejects.toThrow(/401/);
    expect(callCount).toBe(1);
  });

  it("recovers from context overflow and retries", async () => {
    let callCount = 0;
    const provider: Provider = {
      async *streamChat() {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("400 context_length_exceeded: prompt too long");
        }
        yield { type: "text", content: "recovered" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    };
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [],
      systemPrompt: "sys",
    });
    for (let i = 0; i < 5; i++) {
      agent.messages.push({ role: "user", content: `turn ${i}` });
      agent.messages.push({ role: "assistant", content: `reply ${i}` });
    }

    const events = await collectEvents(agent, "latest", "/tmp");
    expect(events.some((e) => e.type === "context_recovered")).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.content === "recovered")).toBe(true);
    expect(callCount).toBe(2);
  });

  describe("todos", () => {
    it("yields a todos_updated event after a tool mutates todos", async () => {
      let appendedTodos: any[] | undefined;
      const todoMutator: ToolRegistryEntry = {
        name: "todo_write",
        readOnly: true,
        description: "writes todos",
        parameters: { type: "object", properties: {}, required: [] },
        async execute(_args, _ctx) {
          return { content: "updated" };
        },
      };

      const provider = createMockProvider([
        [
          { type: "tool_call", id: "tc_1", name: "todo_write", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_1", name: "todo_write", arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "ok" }, { type: "done" }],
      ]);

      const agent = new Agent({
        provider,
        model: "gpt-4o",
        tools: [todoMutator],
        onTodosUpdate: (todos) => {
          appendedTodos = todos;
        },
      });

      // Simulate the tool mutating state during execution.
      const originalExecute = todoMutator.execute;
      todoMutator.execute = async (args, ctx) => {
        agent.setTodos([{ content: "one", activeForm: "doing one", status: "in_progress" }]);
        return originalExecute(args, ctx);
      };

      const events = await collectEvents(agent, "go", "/tmp");
      const updated = events.find((e) => e.type === "todos_updated") as any;
      expect(updated).toBeTruthy();
      expect(updated.todos).toEqual([
        { content: "one", activeForm: "doing one", status: "in_progress" },
      ]);
      expect(appendedTodos).toEqual([
        { content: "one", activeForm: "doing one", status: "in_progress" },
      ]);
    });

    it("does not emit todos_updated when a tool leaves the list unchanged", async () => {
      const inertTool: ToolRegistryEntry = {
        name: "inert",
        readOnly: true,
        description: "no-op",
        parameters: { type: "object", properties: {}, required: [] },
        async execute() {
          return { content: "nothing" };
        },
      };
      const provider = createMockProvider([
        [
          { type: "tool_call", id: "tc_1", name: "inert", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_1", name: "inert", arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "done" }, { type: "done" }],
      ]);
      const agent = new Agent({ provider, model: "gpt-4o", tools: [inertTool] });
      const events = await collectEvents(agent, "go", "/tmp");
      expect(events.some((e) => e.type === "todos_updated")).toBe(false);
    });

    it("accepts initial todos and exposes them via getTodos()", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        todos: [{ content: "bootstrap", activeForm: "bootstrapping", status: "pending" }],
      });
      expect(agent.getTodos()).toEqual([
        { content: "bootstrap", activeForm: "bootstrapping", status: "pending" },
      ]);
    });
  });

  describe("plan mode", () => {
    const writeTool: ToolRegistryEntry = {
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "wrote" };
      },
    };
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      description: "read",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "read ok" };
      },
    };

    const singleCallProvider = (toolName: string) =>
      createMockProvider([
        [
          { type: "tool_call", id: "tc_1", name: toolName, arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_1", name: toolName, arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "ok" }, { type: "done" }],
      ]);

    it("rejects non-readOnly tools in plan mode", async () => {
      const agent = new Agent({
        provider: singleCallProvider("write"),
        model: "gpt-4o",
        tools: [writeTool, readTool],
        mode: "plan",
      });
      const events = await collectEvents(agent, "go", "/tmp");
      const toolEnd = events.find((e) => e.type === "tool_end") as any;
      expect(toolEnd.result.isError).toBe(true);
      expect(toolEnd.result.content).toContain("plan mode");
      expect(toolEnd.result.content).toContain("exit_plan_mode");
    });

    it("allows readOnly tools in plan mode", async () => {
      const agent = new Agent({
        provider: singleCallProvider("read"),
        model: "gpt-4o",
        tools: [writeTool, readTool],
        mode: "plan",
      });
      const events = await collectEvents(agent, "go", "/tmp");
      const toolEnd = events.find((e) => e.type === "tool_end") as any;
      expect(toolEnd.result.isError).toBeFalsy();
      expect(toolEnd.result.content).toBe("read ok");
    });

    it("allows non-readOnly tools in default mode", async () => {
      const agent = new Agent({
        provider: singleCallProvider("write"),
        model: "gpt-4o",
        tools: [writeTool, readTool],
        // mode defaults to "default"
      });
      const events = await collectEvents(agent, "go", "/tmp");
      const toolEnd = events.find((e) => e.type === "tool_end") as any;
      expect(toolEnd.result.isError).toBeFalsy();
      expect(toolEnd.result.content).toBe("wrote");
    });

    it("yields mode_changed when a tool flips the mode via setMode", async () => {
      const flipTool: ToolRegistryEntry = {
        name: "flip",
        readOnly: true,
        description: "flip",
        parameters: { type: "object", properties: {}, required: [] },
        async execute() {
          return { content: "ok" };
        },
      };
      const provider = createMockProvider([
        [
          { type: "tool_call", id: "tc_1", name: "flip", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_1", name: "flip", arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "done" }, { type: "done" }],
      ]);
      const modeUpdates: string[] = [];
      const agent = new Agent({
        provider,
        model: "gpt-4o",
        tools: [flipTool],
        mode: "plan",
        onModeUpdate: (m) => modeUpdates.push(m),
      });
      flipTool.execute = async () => {
        agent.setMode("default");
        return { content: "flipped" };
      };

      const events = await collectEvents(agent, "go", "/tmp");
      const modeEvent = events.find((e) => e.type === "mode_changed") as any;
      expect(modeEvent).toBeTruthy();
      expect(modeEvent.mode).toBe("default");
      expect(modeUpdates).toEqual(["default"]);
      expect(agent.mode).toBe("default");
    });

    it("does not yield mode_changed when setMode is called with the current mode", async () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
      });
      expect(agent.mode).toBe("default");
      agent.setMode("default");
      expect(agent.modeVersion).toBe(0);
    });

    it("injects a plan-mode <system-reminder> when booting in plan mode", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable system prompt",
        mode: "plan",
      });
      const metaMessages = agent.messages.filter(
        (m) => m.role === "user" && (m as any).isMeta,
      );
      expect(metaMessages).toHaveLength(1);
      expect((metaMessages[0] as any).content).toContain("<system-reminder>");
      expect((metaMessages[0] as any).content).toContain("Plan mode is now ACTIVE");
    });

    it("injects enter/exit <system-reminder>s on mode transitions", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });
      expect(agent.messages.filter((m) => m.role === "user" && (m as any).isMeta)).toHaveLength(0);

      agent.setMode("plan");
      let metas = agent.messages.filter((m) => m.role === "user" && (m as any).isMeta);
      expect(metas).toHaveLength(1);
      expect((metas[0] as any).content).toContain("Plan mode is now ACTIVE");

      agent.setMode("default");
      metas = agent.messages.filter((m) => m.role === "user" && (m as any).isMeta);
      expect(metas).toHaveLength(2);
      expect((metas[1] as any).content).toContain("Permission mode is now: default");
    });

    it("injects an acceptEdits reminder when switching to acceptEdits", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });
      agent.setMode("acceptEdits");
      const metas = agent.messages.filter((m) => m.role === "user" && (m as any).isMeta);
      expect(metas).toHaveLength(1);
      expect((metas[0] as any).content).toContain("acceptEdits");
      expect((metas[0] as any).content).toContain("blanket approval");
    });

    it("injects a bypass reminder when switching to bypassPermissions", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });
      agent.setMode("bypassPermissions");
      const metas = agent.messages.filter((m) => m.role === "user" && (m as any).isMeta);
      expect(metas).toHaveLength(1);
      expect((metas[0] as any).content).toContain("bypassPermissions");
      expect((metas[0] as any).content).toContain("auto-approve");
    });

    it("keeps the static system prompt unchanged across mode flips", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable system prompt",
      });
      const before = (agent.messages[0] as any).content;
      agent.setMode("plan");
      agent.setMode("default");
      agent.setMode("plan");
      expect((agent.messages[0] as any).content).toBe(before);
    });
  });

  it("gives up after 3 consecutive overflow attempts", async () => {
    let callCount = 0;
    const provider: Provider = {
      async *streamChat() {
        callCount += 1;
        throw new Error("Prompt is too long");
      },
      async complete() {
        return "";
      },
    };
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [],
      systemPrompt: "sys",
    });
    for (let i = 0; i < 10; i++) {
      agent.messages.push({ role: "user", content: `turn ${i}` });
      agent.messages.push({ role: "assistant", content: `reply ${i}` });
    }

    await expect(collectEvents(agent, "latest", "/tmp")).rejects.toThrow(/too long/i);
    expect(callCount).toBe(4); // initial + 3 retries
  });
});
