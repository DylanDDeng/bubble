import { describe, expect, it } from "vitest";
import { Agent, AgentAbortError, type AgentRunOptions } from "../agent.js";
import { BudgetLedger } from "../agent/budget-ledger.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import type { AgentProfile } from "../agent/profiles.js";
import { projectMessages } from "../context/projector.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolRegistryEntry, ToolResult } from "../types.js";

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

function collectEvents(agent: Agent, input: string, cwd: string, options?: AgentRunOptions): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  return (async () => {
    for await (const event of agent.run(input, cwd, options)) {
      events.push(event);
    }
    return events;
  })();
}


function toolForAgentTest(name: string): ToolRegistryEntry {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: `${name} ok`, status: "success" };
    },
  };
}

function hasSystemContext(messages: Message[], text: string): boolean {
  return messages.some((message) => message.role === "system" && message.content.includes(text));
}

function hasUserText(messages: Message[], text: string): boolean {
  return messages.some((message) => (
    message.role === "user"
    && typeof message.content === "string"
    && message.content.includes(text)
  ));
}

function hasModelContext(messages: Message[], text: string): boolean {
  return messages.some((message) => (
    (message.role === "system" || message.role === "user")
    && typeof message.content === "string"
    && message.content.includes(text)
  ));
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

  it("carries the persistent memory prompt into the model-switch prompt options", () => {
    const provider = createMockProvider([]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      memoryPrompt: "Memory context visible to selected agents.",
    });

    expect(agent.getSystemPromptToolOptions().memoryPrompt).toBe("Memory context visible to selected agents.");
  });

  it("persists and reports the provider backend fingerprint", async () => {
    const provider = createMockProvider([[
      { type: "response_metadata", systemFingerprint: "fp_v4pro_test" },
      { type: "text", content: "Hello!" },
      { type: "done" },
    ]]);
    const agent = new Agent({ provider, model: "deepseek-v4-pro", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      systemFingerprint: "fp_v4pro_test",
    });
    expect(events.find((event) => event.type === "turn_end")).toMatchObject({
      type: "turn_end",
      systemFingerprint: "fp_v4pro_test",
    });
  });

  it("summarizeForCompaction streams deltas and strips leaked reminder markup", async () => {
    const provider = createMockProvider([
      [
        { type: "text", content: "## Summary\n" },
        { type: "text", content: '<bubble_internal_reminder kind="x">secret</bubble_internal_reminder>\n' },
        { type: "text", content: "- did the work" },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const deltas: string[] = [];
    const summary = await agent.summarizeForCompaction(
      [{ role: "user", content: "old task" }],
      (_full, delta) => deltas.push(delta),
    );

    // Streamed incrementally for progress…
    expect(deltas.length).toBeGreaterThan(1);
    // …but the returned (stored + re-injected) summary is sanitized.
    expect(summary).not.toContain("bubble_internal_reminder");
    expect(summary).not.toContain("secret");
    expect(summary).toContain("did the work");
  });

  it("sanitizes internal runtime reminders from streamed reasoning before events and history", async () => {
    const provider = createMockProvider([
      [
        { type: "reasoning_delta", content: "normal before Runtime " },
        { type: "reasoning_delta", content: "reminder:\nRepository orientation workflow:\n" },
        { type: "reasoning_delta", content: "- Start with the repo purpose and main execution paths.\n" },
        { type: "reasoning_delta", content: "- Inspect README/package metadata plus core runtime files before summarizing.\n" },
        { type: "reasoning_delta", content: "- Keep the first pass read-only unless the user asks for changes or runtime verification. normal after" },
        { type: "text", content: "Done." },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");
    const reasoningText = events
      .filter((event): event is Extract<AgentEvent, { type: "reasoning_delta" }> => event.type === "reasoning_delta")
      .map((event) => event.content)
      .join("");
    const assistant = agent.messages.find((message) => message.role === "assistant");

    expect(reasoningText).toContain("normal before");
    expect(reasoningText).toContain("normal after");
    expect(reasoningText).not.toContain("Runtime reminder");
    expect(reasoningText).not.toContain("Repository orientation workflow");
    expect(assistant?.role === "assistant" ? assistant.reasoning : "").toBe(reasoningText);
  });

  it("sanitizes echoed internal reminders from streamed assistant text", async () => {
    const provider = createMockProvider([
      [
        { type: "text", content: "visible before <bubble_internal_" },
        { type: "text", content: "reminder kind=\"system-reminder\">\nPermission mode is now: bypassPermissions.\n" },
        { type: "text", content: "ALL tool calls auto-approve with no user confirmation.\n</bubble_internal_reminder> visible after" },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    agent.setMode("bypassPermissions");

    const events = await collectEvents(agent, "Hi", "/tmp");
    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.content)
      .join("");
    const assistant = agent.messages.find((message) => message.role === "assistant");

    expect(text).toBe("visible before  visible after");
    expect(text).not.toContain("<bubble_internal_reminder");
    expect(text).not.toContain("bypassPermissions");
    expect(assistant?.role === "assistant" ? assistant.content : "").toBe(text);
  });

  it("preserves a clean signed thinking block while sanitizing reasoning", async () => {
    const cleanThinking = "Let me inspect the parser before editing.";
    const provider = createMockProvider([
      [
        { type: "reasoning_delta", content: "normal before Runtime reminder:\nRepository orientation workflow:\n- keep raw" },
        { type: "provider_content_block", provider: "anthropic", block: { type: "thinking", thinking: cleanThinking, signature: "sig_raw" } },
        { type: "provider_content_block", provider: "anthropic", block: { type: "text", text: "Done." } },
        { type: "text", content: "Done." },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "minimax:MiniMax-M3", tools: [] });
    await collectEvents(agent, "Hi", "/tmp");

    const assistant = agent.messages.find((message) => message.role === "assistant") as any;
    expect(assistant.reasoning).not.toContain("Repository orientation workflow");
    expect(assistant.providerMetadata.anthropic.contentBlocks[0]).toEqual({
      type: "thinking",
      thinking: cleanThinking,
      signature: "sig_raw",
    });
  });

  it("drops a provider thinking block that carries an echoed internal reminder", async () => {
    const leakedThinking = [
      "The reminder says: ",
      "<bubble_internal_reminder kind=\"system-reminder\">\n",
      "Debugging workflow:\n- Reproduce or identify the failing boundary before editing.\n",
      "</bubble_internal_reminder>",
    ].join("");
    const provider = createMockProvider([
      [
        { type: "reasoning_delta", content: leakedThinking },
        { type: "provider_content_block", provider: "anthropic", block: { type: "thinking", thinking: leakedThinking, signature: "sig_leak" } },
        { type: "provider_content_block", provider: "anthropic", block: { type: "text", text: "Done." } },
        { type: "text", content: "Done." },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "minimax:MiniMax-M3", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    const assistant = agent.messages.find((message) => message.role === "assistant") as any;
    // The signed thinking block carrying the reminder is dropped (cannot be
    // rewritten without breaking its signature); only the text block remains.
    const blocks = assistant.providerMetadata.anthropic.contentBlocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "Done." });
    expect(JSON.stringify(assistant)).not.toContain("bubble_internal_reminder");
    expect(JSON.stringify(assistant)).not.toContain("Debugging workflow");
    // And nothing reminder-shaped reached the user-visible event stream.
    const visible = events.filter((e) => e.type === "text_delta" || e.type === "reasoning_delta").map((e: any) => e.content).join("");
    expect(visible).not.toContain("bubble_internal_reminder");
    expect(visible).not.toContain("Debugging workflow");
  });

  it("retries a reasoning-only assistant turn instead of appending invalid history", async () => {
    const providerCalls: any[][] = [];
    let callIndex = 0;
    const provider: Provider = {
      async *streamChat(messages) {
        providerCalls.push(messages as any[]);
        if (callIndex++ === 0) {
          yield { type: "reasoning_delta", content: "This should have been visible." };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "Visible retry answer." };
        yield { type: "done" };
      },
      async complete() {
        return "mock completion";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]?.some((message) => message.role === "assistant")).toBe(false);
    expect(providerCalls[1]?.some((message) => (
      message.role === "user"
      && message.content.includes("<bubble_internal_reminder")
      && message.content.includes("no user-visible assistant content")
    ))).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.content === "Visible retry answer.")).toBe(true);
    expect(agent.messages.filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Visible retry answer.",
        reasoning: "",
        toolCalls: [],
      }),
    ]);
  });

  it("emits a visible fallback when empty assistant recovery fails", async () => {
    const provider = createMockProvider([
      [{ type: "reasoning_delta", content: "hidden only once" }, { type: "done" }],
      [{ type: "reasoning_delta", content: "hidden only twice" }, { type: "done" }],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    expect(events).toContainEqual({
      type: "text_delta",
      content: "The model returned no user-visible response. Please retry, or switch models if this keeps happening.",
    });
    const assistantMessages = agent.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toContain("no user-visible response");
    expect(assistantMessages[0]?.reasoning).toBe("");
  });

  it("aborts a running model stream with an interrupted assistant boundary", async () => {
    const controller = new AbortController();
    let callCount = 0;
    let followupMessages: any[] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        if (callCount++ === 0) {
          expect(options.abortSignal).toBe(controller.signal);
          yield { type: "text", content: "partial" };
          controller.abort(new AgentAbortError("stop"));
          yield { type: "text", content: "late" };
          return;
        }
        followupMessages = messages as any[];
        yield { type: "text", content: "new answer" };
        yield { type: "done" };
      },
      async complete() {
        return "mock completion";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events: AgentEvent[] = [];

    await expect(async () => {
      for await (const event of agent.run("Hi", "/tmp", { abortSignal: controller.signal })) {
        events.push(event);
      }
    }).rejects.toThrow(AgentAbortError);

    expect(events.some((event) => event.type === "text_delta" && event.content === "partial")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.content === "late")).toBe(false);
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[0]).toEqual({ role: "user", content: "Hi" });
    expect(agent.messages[1]).toMatchObject({
      role: "assistant",
      error: { name: "MessageAbortedError", aborted: true },
    });
    expect((agent.messages[1] as any).content).toContain("partial");
    expect((agent.messages[1] as any).content).toContain("Interrupted by user");

    const followupEvents = await collectEvents(agent, "New request", "/tmp");
    expect(followupEvents).toContainEqual({ type: "text_delta", content: "new answer" });
    expect(followupMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(followupMessages[1]).toMatchObject({
      role: "assistant",
      error: { name: "MessageAbortedError", aborted: true },
    });
  });

  it("terminalizes a never-settling tool when the run is aborted", async () => {
    const controller = new AbortController();
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_never", name: "never_tool", arguments: "{}", isStart: true, isEnd: true },
        { type: "tool_call", id: "tc_later", name: "later_tool", arguments: "{}", isStart: true, isEnd: true },
        { type: "done" },
      ],
    ]);
    const neverTool: ToolRegistryEntry = {
      name: "never_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return await new Promise<ToolResult>(() => {});
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [neverTool] });
    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const event of agent.run("Call never tool", "/tmp", { abortSignal: controller.signal })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.type === "tool_start" && event.name === "never_tool"));
    controller.abort(new AgentAbortError("stop"));

    await expect(run).rejects.toThrow(AgentAbortError);
    const toolEnd = events.find((event) => event.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>;
    expect(toolEnd.result.status).toBe("cancelled");
    expect(toolEnd.result.isError).toBe(true);
    const toolMessages = agent.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["tc_never", "tc_later"]);
    expect(toolMessages[0]?.metadata?.reason).toBe("cancelled");
    expect(toolMessages[1]?.metadata?.reason).toBe("cancelled");
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

  it("emits tool-call streaming lifecycle before executing the tool", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: '{"value"', isStart: false, isEnd: false },
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: ':"42"}', isStart: false, isEnd: true },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Call dummy", "/tmp");
    const sequence = events.map((event) => event.type);

    expect(sequence.indexOf("tool_call_start")).toBeLessThan(sequence.indexOf("tool_call_delta"));
    expect(sequence.indexOf("tool_call_delta")).toBeLessThan(sequence.indexOf("tool_call_end"));
    expect(sequence.indexOf("tool_call_end")).toBeLessThan(sequence.indexOf("tool_start"));
    expect(events.filter((event) => event.type === "tool_call_delta").map((event) => event.arguments)).toEqual([
      '{"value"',
      '{"value":"42"}',
    ]);
  });

  it("keeps interleaved streaming tool-call arguments isolated by id", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        { type: "tool_call", id: "tc_2", name: "dummy", arguments: "", isStart: true, isEnd: false },
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: '{"value":"1"}', isStart: false, isEnd: true },
        { type: "tool_call", id: "tc_2", name: "dummy", arguments: '{"value":"2"}', isStart: false, isEnd: true },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Call dummy twice", "/tmp");

    const toolCallEndEvents = events.filter((event) => event.type === "tool_call_end");
    expect(toolCallEndEvents).toEqual([
      expect.objectContaining({ id: "tc_1", arguments: '{"value":"1"}' }),
      expect.objectContaining({ id: "tc_2", arguments: '{"value":"2"}' }),
    ]);
  });

  it("persists tool metadata and error state on tool messages", async () => {
    const metadataTool: ToolRegistryEntry = {
      name: "metadata_tool",
      description: "A tool with structured metadata",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        return {
          content: "blocked by user",
          isError: true,
          status: "blocked",
          metadata: { kind: "question", rejected: true },
        };
      },
    };
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_meta", name: "metadata_tool", arguments: "{}", isStart: true, isEnd: true },
        { type: "done" },
      ],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [metadataTool] });

    await collectEvents(agent, "Call metadata tool", "/tmp");

    const toolMessage = agent.messages.find((m) => m.role === "tool");
    expect(toolMessage?.isError).toBe(true);
    expect(toolMessage?.metadata).toEqual({ kind: "question", rejected: true });
  });

  it("emits a turn boundary between tool execution and the final answer", async () => {
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
    const eventTypes = events.map((event) => event.type);

    expect(eventTypes).toEqual([
      "turn_start",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "tool_start",
      "tool_end",
      "turn_end",
      "turn_start",
      "text_delta",
      "turn_end",
      "agent_end",
    ]);
    expect(events
      .filter((event): event is Extract<AgentEvent, { type: "turn_end" }> => event.type === "turn_end")
      .map((event) => event.willContinue ?? false)).toEqual([true, false]);
  });

  it("rejects pending boundary input when the response has no continuation", async () => {
    const inputQueue = new AgentRunInputQueue("test-steer");
    const provider: Provider = {
      async *streamChat() {
        inputQueue.enqueue("follow-up detail");
        yield { type: "text", content: "Done" };
        yield { type: "done" };
      },
      async complete() {
        return "mock completion";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events: AgentEvent[] = [];

    for await (const event of agent.run("Hi", "/tmp", { inputController: inputQueue })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "input_rejected",
      content: "follow-up detail",
      reason: "no_continuation",
      target: "next_turn",
    }));
    expect(hasUserText(agent.messages, "follow-up detail")).toBe(false);
  });

  it("applies boundary input before the next provider call after tool continuation", async () => {
    const inputQueue = new AgentRunInputQueue("test-steer");
    const providerCalls: any[][] = [];
    let callIndex = 0;
    const provider: Provider = {
      async *streamChat(messages) {
        providerCalls.push(messages as any[]);
        if (callIndex++ === 0) {
          yield { type: "tool_call", id: "tc_1", name: "steer_tool", arguments: "{}", isStart: true, isEnd: true };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "Done" };
        yield { type: "done" };
      },
      async complete() {
        return "mock completion";
      },
    };
    const steerTool: ToolRegistryEntry = {
      name: "steer_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        inputQueue.enqueue("include the queued detail");
        return { content: "tool ok" };
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [steerTool] });
    const events: AgentEvent[] = [];

    for await (const event of agent.run("Call tool", "/tmp", { inputController: inputQueue })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "input_applied",
      content: "include the queued detail",
      target: "current_turn",
    }));
    expect(providerCalls).toHaveLength(2);
    const secondCall = providerCalls[1]!;
    const toolIndex = secondCall.findIndex((message) => message.role === "tool");
    const steerIndex = secondCall.findIndex((message) => (
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("include the queued detail")
    ));
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(steerIndex).toBeGreaterThan(toolIndex);

    const eventTypes = events.map((event) => event.type);
    const firstTurnEnd = eventTypes.indexOf("turn_end");
    const applied = eventTypes.indexOf("input_applied");
    const secondTurnStart = eventTypes.indexOf("turn_start", firstTurnEnd + 1);
    expect(applied).toBeGreaterThan(firstTurnEnd);
    expect(applied).toBeLessThan(secondTurnStart);
  });

  it("applies boundary input after every tool result in a multi-tool turn", async () => {
    const inputQueue = new AgentRunInputQueue("test-steer");
    let executionCount = 0;
    const multiTool: ToolRegistryEntry = {
      name: "multi_tool",
      description: "",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      async execute() {
        executionCount += 1;
        if (executionCount === 1) inputQueue.enqueue("after both tools");
        return { content: `tool ${executionCount} ok` };
      },
    };
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "multi_tool", arguments: '{"value":"1"}', isStart: true, isEnd: true },
        { type: "tool_call", id: "tc_2", name: "multi_tool", arguments: '{"value":"2"}', isStart: true, isEnd: true },
        { type: "done" },
      ],
      [{ type: "text", content: "Done" }, { type: "done" }],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [multiTool] });

    await collectEvents(agent, "Call both tools", "/tmp", { inputController: inputQueue });

    const steerIndex = agent.messages.findIndex((message) => (
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("after both tools")
    ));
    const toolIndexes = agent.messages
      .map((message, index) => message.role === "tool" ? index : -1)
      .filter((index) => index >= 0);
    expect(toolIndexes).toHaveLength(2);
    expect(steerIndex).toBeGreaterThan(Math.max(...toolIndexes));
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

  it("notifies onContextChanged subscribers on every resident-context mutation", async () => {
    const provider = createMockProvider([
      [{ type: "text", content: "ok" }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
    });
    let notifications = 0;
    const unsubscribe = agent.onContextChanged(() => {
      notifications += 1;
    });

    // Whole-array rewrites (the /clear, /rewind, /compact, session-switch path).
    agent.messages = [{ role: "system", content: "system" }];
    expect(notifications).toBe(1);

    // Run-loop appends (user + assistant via appendMessage).
    await collectEvents(agent, "Hi", "/tmp");
    expect(notifications).toBeGreaterThanOrEqual(3);
    const afterRun = notifications;

    // Model switches change the context window reading.
    agent.model = "gpt-4o-mini";
    expect(notifications).toBe(afterRun + 1);

    // setSystemPrompt mutates resident context in place.
    agent.setSystemPrompt("replaced");
    expect(notifications).toBe(afterRun + 2);

    // Unsubscribe stops delivery.
    unsubscribe();
    agent.messages = [];
    expect(notifications).toBe(afterRun + 2);
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

  it("rejects a tool call whose arguments are not valid JSON", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_corrupt", name: "dummy", arguments: "", isStart: true, isEnd: false },
        {
          type: "tool_call",
          id: "tc_corrupt",
          name: "dummy",
          arguments: '{"value":"unfini',
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "retry result" }, { type: "done" }],
    ]);

    let executions = 0;
    const tool: ToolRegistryEntry = {
      name: "dummy",
      description: "",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      async execute(args) {
        executions += 1;
        return { content: `executed with ${args.value ?? "nothing"}` };
      },
    };

    const seen: Array<{ toolName: string; content: string; isError?: boolean }> = [];
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [tool],
      onToolResult: (toolName, result) => {
        seen.push({ toolName, content: result.content, isError: result.isError });
      },
    });

    await collectEvents(agent, "Call dummy", "/tmp");
    expect(executions).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].isError).toBe(true);
    expect(seen[0].content).toContain("failed to parse as JSON");
  });

  it("rejects a tool call whose provider-side stream was marked corrupt", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_corrupt2", name: "dummy", arguments: "", isStart: true, isEnd: false },
        // argumentsFull is parseable JSON ({}) but the provider flagged the
        // stream as corrupt — simulating normalizeToolArgs's salvage path
        // that recovered nothing meaningful.
        {
          type: "tool_call",
          id: "tc_corrupt2",
          name: "dummy",
          arguments: "",
          argumentsFull: "{}",
          argumentsCorrupt: true,
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "retry" }, { type: "done" }],
    ]);

    let executions = 0;
    const tool: ToolRegistryEntry = {
      name: "dummy",
      description: "",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      async execute() {
        executions += 1;
        return { content: "should not run" };
      },
    };

    const seen: Array<{ content: string; isError?: boolean }> = [];
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [tool],
      onToolResult: (_toolName, result) => {
        seen.push({ content: result.content, isError: result.isError });
      },
    });

    await collectEvents(agent, "go", "/tmp");
    expect(executions).toBe(0);
    expect(seen[0].isError).toBe(true);
    expect(seen[0].content).toContain("failed to parse as JSON");
  });

  it("rejects a tool call missing a required argument", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_empty", name: "dummy", arguments: "", isStart: true, isEnd: false },
        {
          type: "tool_call",
          id: "tc_empty",
          name: "dummy",
          arguments: "{}",
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "ack" }, { type: "done" }],
    ]);

    let executions = 0;
    const tool: ToolRegistryEntry = {
      name: "dummy",
      description: "",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      async execute() {
        executions += 1;
        return { content: "should not run" };
      },
    };

    const seen: Array<{ content: string; isError?: boolean }> = [];
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [tool],
      onToolResult: (_toolName, result) => {
        seen.push({ content: result.content, isError: result.isError });
      },
    });

    await collectEvents(agent, "Call dummy", "/tmp");
    expect(executions).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].isError).toBe(true);
    expect(seen[0].content).toContain('"value"');
    expect(seen[0].content).toContain("required argument");
  });

  it("allows tools whose required list is empty to be called with empty args", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_noargs", name: "noargs", arguments: "{}", isStart: true, isEnd: true },
        { type: "done" },
      ],
      [{ type: "text", content: "ok" }, { type: "done" }],
    ]);

    const tool: ToolRegistryEntry = {
      name: "noargs",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "noargs ran" };
      },
    };

    const seen: Array<{ content: string; isError?: boolean }> = [];
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [tool],
      onToolResult: (_toolName, result) => {
        seen.push({ content: result.content, isError: result.isError });
      },
    });

    await collectEvents(agent, "go", "/tmp");
    expect(seen[0].isError).toBeFalsy();
    expect(seen[0].content).toBe("noargs ran");
  });

  it("allows custom hooks to block tool execution", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "{\"value\":\"42\"}", isStart: false, isEnd: true },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [dummyTool],
      hooks: [{
        beforeToolCall(ctx) {
          ctx.blockToolCall({
            content: "blocked by custom hook",
            isError: true,
            status: "blocked",
          });
        },
      }],
    });

    const events = await collectEvents(agent, "Call dummy", "/tmp");
    const toolEnd = events.find((event) => event.type === "tool_end") as any;
    expect(toolEnd.result.content).toBe("blocked by custom hook");
  });

  it("keeps exploration tools available after repeated implementation reads", async () => {
    const toolNamesByCall: string[][] = [];
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        captured.push(messages);
        toolNamesByCall.push((options.tools ?? []).map((tool) => tool.name));
        if (toolNamesByCall.length === 1 || toolNamesByCall.length === 2) {
          yield { type: "tool_call", id: `read_${toolNamesByCall.length}`, name: "read", arguments: "", isStart: true, isEnd: false };
          yield {
            type: "tool_call",
            id: `read_${toolNamesByCall.length}`,
            name: "read",
            arguments: "{\"path\":\"index.html\",\"offset\":1,\"limit\":100}",
            isStart: false,
            isEnd: true,
          };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "Ready to edit." };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: "<html></html>",
          status: "success",
          metadata: { kind: "read", path: "index.html" },
        };
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [readTool, toolForAgentTest("edit"), toolForAgentTest("write"), toolForAgentTest("bash"), toolForAgentTest("lsp")],
    });

    const events = await collectEvents(agent, "改一下任意 html 文件", "/tmp");
    const repeatedRead = events.find((event) => event.type === "tool_end" && event.id === "read_2") as any;
    expect(repeatedRead.result.status).toBe("success");
    expect(toolNamesByCall[2]).toEqual(["read", "edit", "write", "bash", "lsp"]);
  });

  it("emits live tool_update events from tools", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "sub_1", name: "subagent_like", arguments: "", isStart: true, isEnd: false },
        { type: "tool_call", id: "sub_1", name: "subagent_like", arguments: "{}", isStart: false, isEnd: true },
      ],
      [{ type: "text", content: "done" }],
    ]);
    const liveTool: ToolRegistryEntry = {
      name: "subagent_like",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.emitUpdate?.({
          type: "subagent_update",
          parentToolCallId: ctx.toolCall?.id ?? "sub_1",
          runId: "run_1",
          subAgentId: "child_1",
          agentName: "scout",
          status: "running",
          message: "running scout",
        });
        return { content: "subagent complete", metadata: { kind: "subagent" } };
      },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [liveTool],
      systemPrompt: "system",
    });

    const events = await collectEvents(agent, "run subagent", "/tmp");
    const update = events.find((event) => event.type === "tool_update") as Extract<AgentEvent, { type: "tool_update" }>;
    const end = events.find((event) => event.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>;

    expect(update.update.subAgentId).toBe("child_1");
    expect(update.update.message).toBe("running scout");
    expect(events.indexOf(update)).toBeLessThan(events.indexOf(end));
  });

  it("injects current subagent lifecycle truth before continuing after lifecycle tools", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        captured.push(messages);
        if (captured.length === 1) {
          yield { type: "tool_call", id: "spawn_1", name: "spawn_agent", arguments: "{}", isStart: true, isEnd: true };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "done" };
      },
      async complete() {
        return "ok";
      },
    };
    const lifecycleTool: ToolRegistryEntry = {
      name: "spawn_agent",
      readOnly: true,
      effect: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: "Spawned Ada",
          metadata: {
            kind: "subagent",
            subagents: [
              { subAgentId: "agent_1", agentName: "explorer", nickname: "Ada", status: "queued" },
              { subAgentId: "agent_1", agentName: "explorer", nickname: "Ada", status: "completed" },
              { subAgentId: "agent_2", agentName: "explorer", nickname: "Grace", status: "completed" },
            ],
          },
        };
      },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [lifecycleTool],
      systemPrompt: "system",
    });

    await collectEvents(agent, "spawn children", "/tmp");

    const lifecycleReminder = captured[1].find((message) => (
      (message.role === "system" || message.role === "user")
      && typeof message.content === "string"
      && message.content.includes("Subagent lifecycle truth")
    ));
    expect(lifecycleReminder?.content).toContain("Unique subagents currently tracked: 2.");
    expect(lifecycleReminder?.content).toContain("completed=2");
    expect(lifecycleReminder?.content).toContain("do not count repeated spawn_agent/wait_agent tool calls");
    expect(lifecycleReminder?.content).toContain("call wait_agent before user-facing progress narration");
  });

  it("propagates parent abort signals into subagent provider calls", async () => {
    const controller = new AbortController();
    let providerSawSignal = false;
    const provider: Provider = {
      async *streamChat(_messages, options) {
        providerSawSignal = !!options.abortSignal;
        controller.abort(new AgentAbortError("stop child"));
        if (options.abortSignal?.aborted) {
          throw options.abortSignal.reason;
        }
        yield { type: "text", content: "late" };
      },
      async complete() {
        return "ok";
      },
    };
    const profile: AgentProfile = {
      name: "abort-test",
      description: "Abort test",
      source: "builtin",
      mode: "readonly",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Return briefly.",
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      systemPrompt: "system",
    });

    const result = await agent.runSubAgent("abort me", "/tmp", {
      profile,
      runId: "run-abort",
      subAgentId: "child-abort",
      parentToolCallId: "parent",
      abortSignal: controller.signal,
    });

    expect(providerSawSignal).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("stop child");
  });

  it("adds memory prompt context to subagents without advertising skill summaries", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        captured.push(messages);
        yield { type: "text", content: "done" };
      },
      async complete() {
        return "ok";
      },
    };
    const profile: AgentProfile = {
      name: "context-test",
      description: "Context test",
      source: "builtin",
      mode: "readonly",
      tools: {
        preset: "explicit",
        include: ["skill", "memory"],
      },
      approval: "fail",
      prompt: "Use selected context.",
    };
    const tool = (name: string): ToolRegistryEntry => ({
      name,
      readOnly: true,
      effect: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "ok" };
      },
    });
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [tool("skill"), tool("memory")],
      systemPrompt: "parent system",
      skills: [{ name: "debug-skill", description: "Debug workflow" }],
      memoryPrompt: "Memory context visible to selected agents.",
    });

    await agent.runSubAgent("inspect", "/tmp", {
      profile,
      runId: "run-context",
      subAgentId: "child-context",
      parentToolCallId: "parent",
    });

    const system = captured[0].find((message) => message.role === "system")?.content ?? "";
    expect(system).not.toContain("debug-skill");
    expect(system).toContain("Memory context visible");
    expect(system).toContain("Use selected context.");
  });

  it("applies resolved category routes to child agent model, thinking level, prompt, and result metadata", async () => {
    const calls: Array<{ model: string; thinkingLevel?: string; system: string }> = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        calls.push({
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          system: messages.find((message) => message.role === "system")?.content ?? "",
        });
        yield { type: "text", content: "review complete" };
      },
      async complete() {
        return "ok";
      },
    };
    const profile: AgentProfile = {
      name: "reviewer",
      description: "Review child",
      source: "user",
      mode: "readonly",
      model: "inherit",
      category: "review",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Review carefully.",
    };
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "gpt-4o",
      thinkingLevel: "medium",
      tools: [],
      systemPrompt: "parent system",
      agentCategories: {
        review: { model: "gpt-5.4", thinkingLevel: "high" },
      },
    });

    const result = await agent.runSubAgent("inspect", "/tmp", {
      profile,
      runId: "run-review",
      subAgentId: "child-review",
      parentToolCallId: "parent",
    });

    expect(calls[0]).toMatchObject({ model: "gpt-5.4", thinkingLevel: "high" });
    expect(calls[0].system).toContain("openai:gpt-5.4");
    expect(calls[0].system).toContain("Review carefully.");
    expect(result).toMatchObject({
      status: "completed",
      category: "review",
      route: {
        category: "review",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "high",
        inherited: false,
      },
    });
  });

  it("separates explicit subagent effort clamping from inherited stale-state defaults", () => {
    const profile: AgentProfile = {
      name: "route-check",
      description: "Route check",
      source: "user",
      mode: "readonly",
      model: "inherit",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Check the route.",
    };
    const agent = new Agent({
      provider: createMockProvider([]),
      providerId: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "off",
      tools: [],
      systemPrompt: "system",
    });
    const resolveRoute = (agent as any).resolveRouteForSubagent.bind(agent) as (
      profile: AgentProfile,
      category: string | undefined,
      override?: { model?: string; effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" },
    ) => { model: string; thinkingLevel: string };

    expect(resolveRoute(profile, undefined, {
      model: "openai:gpt-5.6-luna",
      effort: "ultra",
    })).toMatchObject({ model: "gpt-5.6-luna", thinkingLevel: "max" });
    expect(resolveRoute(profile, undefined, {
      model: "anthropic:claude-opus-4-8",
      effort: "ultra",
    })).toMatchObject({ model: "claude-opus-4-8", thinkingLevel: "max" });
    expect(resolveRoute(profile, undefined, {
      model: "openai:gpt-5.6-terra",
    })).toMatchObject({ model: "gpt-5.6-terra", thinkingLevel: "medium" });
  });

  it("routes cross-provider subagents through the configured provider factory", async () => {
    const parentProvider: Provider = {
      async *streamChat() {
        throw new Error("parent provider should not run cross-provider child");
      },
      async complete() {
        return "parent";
      },
    };
    const childCalls: Array<{ model: string; thinkingLevel?: string; system: string }> = [];
    const childProvider: Provider = {
      async *streamChat(messages, options) {
        childCalls.push({
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          system: messages.find((message) => message.role === "system")?.content ?? "",
        });
        yield { type: "text", content: "cross provider done" };
      },
      async complete() {
        return "child";
      },
    };
    const profile: AgentProfile = {
      name: "cross-provider",
      description: "Cross provider",
      source: "user",
      mode: "readonly",
      model: "inherit",
      category: "review",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Return briefly.",
    };
    const agent = new Agent({
      provider: parentProvider,
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      tools: [],
      systemPrompt: "system",
      thinkingLevel: "low",
      agentCategories: {
        review: { model: "openai:gpt-5.4", thinkingLevel: "high" },
      },
      providerFactory: async (route) => {
        expect(route.providerId).toBe("openai");
        expect(route.model).toBe("gpt-5.4");
        return childProvider;
      },
    });

    const result = await agent.runSubAgent("inspect", "/tmp", {
      profile,
      runId: "run-cross",
      subAgentId: "child-cross",
      parentToolCallId: "parent",
    });

    expect(childCalls).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        thinkingLevel: "high",
        system: expect.stringContaining("openai:gpt-5.4"),
      }),
    ]);
    expect(result).toMatchObject({
      status: "completed",
      category: "review",
      route: {
        category: "review",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "high",
        inherited: false,
      },
    });
  });

  it("blocks cross-provider subagent routes when no provider factory is configured", async () => {
    const provider = createMockProvider([]);
    const profile: AgentProfile = {
      name: "cross-provider",
      description: "Cross provider",
      source: "user",
      mode: "readonly",
      model: "anthropic:claude-sonnet-4.5",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Return briefly.",
    };
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "gpt-4o",
      tools: [],
      systemPrompt: "system",
    });

    const result = await agent.runSubAgent("inspect", "/tmp", {
      profile,
      runId: "run-cross",
      subAgentId: "child-cross",
      parentToolCallId: "parent",
    });

    expect(result.status).toBe("blocked");
    expect(result.error).toContain('requires provider "anthropic"');
    expect(result.error).toContain("no provider factory");
  });

  it("does not cancel a subagent from a hidden per-child token budget", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "text", content: "expensive" };
        yield { type: "usage", usage: { promptTokens: 6, completionTokens: 1 } };
      },
      async complete() {
        return "ok";
      },
    };
    const profile: AgentProfile = {
      name: "budget-test",
      description: "Budget test",
      source: "builtin",
      mode: "readonly",
      tools: { preset: "none" },
      approval: "fail",
      prompt: "Return briefly.",
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      systemPrompt: "system",
      budgetLedger: new BudgetLedger(),
    });

    const result = await agent.runSubAgent("spend budget", "/tmp", {
      profile,
      runId: "run-budget",
      subAgentId: "child-budget",
      parentToolCallId: "parent",
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("expensive");
    expect(result.error).toBeUndefined();
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

  it("uses per-agent steps to disable tools on the final step", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        captured.push(messages);
        expect(options.tools?.map((tool) => tool.name)).toEqual(["dummy"]);
        expect(options.toolChoice).toBe("none");
        yield { type: "text", content: "Final without tools." };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [dummyTool],
      systemPrompt: "system",
      maxTurns: 1,
    });

    const events = await collectEvents(agent, "Do something", "/tmp");
    expect(events.some((event) => event.type === "text_delta" && event.content === "Final without tools.")).toBe(true);
    expect(hasModelContext(captured[0], "CRITICAL - MAXIMUM STEPS REACHED")).toBe(true);
  });

  it("does not execute provider tool calls during a forced text-only turn", async () => {
    let providerCalls = 0;
    let toolExecutions = 0;
    const guardedTool: ToolRegistryEntry = {
      ...dummyTool,
      async execute() {
        toolExecutions += 1;
        return { content: "should not execute" };
      },
    };
    const provider: Provider = {
      async *streamChat(_messages, options) {
        providerCalls += 1;
        expect(options.tools?.map((tool) => tool.name)).toEqual(["dummy"]);
        expect(options.toolChoice).toBe("none");
        if (providerCalls === 1) {
          yield { type: "tool_call", id: "forbidden_1", name: "dummy", arguments: "", isStart: true, isEnd: false };
          yield { type: "tool_call", id: "forbidden_1", name: "dummy", arguments: "{\"value\":\"42\"}", isStart: false, isEnd: true };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "Final without tools." };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [guardedTool],
      systemPrompt: "system",
      maxTurns: 1,
    });

    const events = await collectEvents(agent, "Do something", "/tmp");
    expect(providerCalls).toBe(2);
    expect(toolExecutions).toBe(0);
    expect(events.some((event) => event.type === "tool_call_start" || event.type === "tool_start")).toBe(false);
    expect(events.some((event) => event.type === "text_delta" && event.content === "Final without tools.")).toBe(true);
    expect(agent.messages.some((message) => message.role === "assistant" && message.toolCalls?.length)).toBe(false);
  });

  it("uses task budget exhaustion to force a text-only follow-up turn", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        captured.push(messages);
        if (captured.length === 1) {
          yield { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false };
          yield { type: "tool_call", id: "tc_1", name: "dummy", arguments: "{\"value\":\"42\"}", isStart: false, isEnd: true };
          yield { type: "usage", usage: { promptTokens: 50, completionTokens: 60 } };
          yield { type: "done" };
          return;
        }
        expect(options.tools?.map((tool) => tool.name)).toEqual(["dummy"]);
        expect(options.toolChoice).toBe("none");
        yield { type: "text", content: "Budget summary." };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [dummyTool],
      systemPrompt: "system",
      taskBudget: { total: 100 },
    });

    const events = await collectEvents(agent, "Call dummy", "/tmp");
    expect(events.some((event) => event.type === "text_delta" && event.content === "Budget summary.")).toBe(true);
    expect(hasModelContext(captured[1], "task budget")).toBe(true);
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
    // Summaries are meta messages rendered as user-role internal blocks in
    // the provider payload (0.0.43+), no longer raw system messages.
    expect(captured[0].some((message) =>
      typeof message.content === "string" && message.content.includes("Previous conversation summary:"))).toBe(true);
  });

  it("shrinks resident history after a long tool-heavy run", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "text", content: "done" };
        yield { type: "done" };
      },
      async complete() {
        return "done";
      },
    };

    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [],
      systemPrompt: "system",
    });

    for (let i = 0; i < 30; i++) {
      agent.messages.push({ role: "user", content: `turn ${i}` });
      agent.messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call_${i}`, name: "read", arguments: `{"path":"file-${i}.ts"}` }],
      });
      agent.messages.push({
        role: "tool",
        toolCallId: `call_${i}`,
        content: `file ${i}\n${"x".repeat(12000)}`,
      });
    }

    const beforeChars = JSON.stringify(agent.messages).length;
    await collectEvents(agent, "latest", "/tmp");
    const afterChars = JSON.stringify(agent.messages).length;

    expect(afterChars).toBeLessThan(beforeChars);
    expect(agent.messages.some((message) => (
      message.role === "tool" && message.content.includes("output omitted to control context size")
    ))).toBe(true);
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
    expect(agent.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("records an interrupted assistant boundary when continuation fails after a tool result", async () => {
    let callCount = 0;
    const provider: Provider = {
      async *streamChat() {
        callCount += 1;
        if (callCount === 1) {
          yield { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false };
          yield { type: "tool_call", id: "tc_1", name: "dummy", arguments: '{"value":"42"}', isStart: false, isEnd: true };
          yield { type: "done" };
          return;
        }
        throw new Error("The socket connection was closed unexpectedly.");
      },
      async complete() {
        return "";
      },
    };
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-5.5",
      tools: [dummyTool],
    });

    await expect(collectEvents(agent, "Call dummy", "/tmp")).rejects.toThrow(/socket connection/i);

    expect(callCount).toBe(2);
    expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const boundary = agent.messages.at(-1);
    expect(boundary).toMatchObject({
      role: "assistant",
      providerId: "openai",
      modelId: "gpt-5.5",
    });
    expect((boundary as any).content).toContain("model request interrupted before a final answer was produced");
    expect((boundary as any).toolCalls).toBeUndefined();
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
    expect(agent.messages.some((message) => (
      message.role === "assistant"
      && message.content.includes("model request interrupted before a final answer was produced")
    ))).toBe(false);
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

    it("clears active todos when a run is interrupted", async () => {
      const controller = new AbortController();
      const provider: Provider = {
        async *streamChat() {
          controller.abort(new AgentAbortError("stop"));
          yield { type: "text", content: "late" };
        },
        async complete() {
          return "mock completion";
        },
      };
      const todoUpdates: any[] = [];
      const agent = new Agent({
        provider,
        model: "gpt-4o",
        tools: [],
        todos: [{ content: "old task", activeForm: "doing old task", status: "in_progress" }],
        onTodosUpdate: (todos) => todoUpdates.push(todos),
      });
      const events: AgentEvent[] = [];

      await expect(async () => {
        for await (const event of agent.run("stop this", "/tmp", { abortSignal: controller.signal })) {
          events.push(event);
        }
      }).rejects.toThrow(AgentAbortError);

      expect(agent.getTodos()).toEqual([]);
      expect(todoUpdates.at(-1)).toEqual([]);
      expect(events).toContainEqual({ type: "todos_updated", todos: [] });
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

    it("keeps exit_plan_mode in the model tool list across permission modes", async () => {
      const exitPlanTool: ToolRegistryEntry = {
        name: "exit_plan_mode",
        readOnly: true,
        description: "exit plan",
        parameters: { type: "object", properties: {}, required: [] },
        async execute() {
          return { content: "unused" };
        },
      };
      const seenByMode: Record<string, string[]> = {};
      const provider: Provider = {
        async *streamChat(_messages, options) {
          seenByMode[options.model] = options.tools?.map((tool) => tool.name) ?? [];
          yield { type: "text", content: "ok" };
          yield { type: "done" };
        },
        async complete() {
          return "";
        },
      };

      await collectEvents(new Agent({
        provider,
        model: "default",
        tools: [readTool, exitPlanTool],
      }), "go", "/tmp");
      await collectEvents(new Agent({
        provider,
        model: "bypass",
        tools: [readTool, exitPlanTool],
        mode: "bypassPermissions",
      }), "go", "/tmp");
      await collectEvents(new Agent({
        provider,
        model: "plan",
        tools: [readTool, exitPlanTool],
        mode: "plan",
      }), "go", "/tmp");

      expect(seenByMode.default).toEqual(["read", "exit_plan_mode"]);
      expect(seenByMode.bypass).toEqual(["read", "exit_plan_mode"]);
      expect(seenByMode.plan).toEqual(["read", "exit_plan_mode"]);
    });

    it("treats hallucinated exit_plan_mode calls outside plan mode as a non-error no-op", async () => {
      const exitPlanTool: ToolRegistryEntry = {
        name: "exit_plan_mode",
        readOnly: true,
        description: "exit plan",
        parameters: { type: "object", properties: {}, required: [] },
        async execute() {
          throw new Error("should not execute outside plan mode");
        },
      };
      const provider = createMockProvider([
        [
          { type: "tool_call", id: "tc_1", name: "exit_plan_mode", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_1", name: "exit_plan_mode", arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [
          { type: "tool_call", id: "tc_2", name: "write", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "tc_2", name: "write", arguments: "{}", isStart: false, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "done" }, { type: "done" }],
      ]);
      const agent = new Agent({
        provider,
        model: "gpt-4o",
        tools: [writeTool, exitPlanTool],
        mode: "bypassPermissions",
      });

      const events = await collectEvents(agent, "go", "/tmp");
      const toolEnds = events.filter((e) => e.type === "tool_end") as any[];
      expect(toolEnds[0].name).toBe("exit_plan_mode");
      expect(toolEnds[0].result.isError).toBeFalsy();
      expect(toolEnds[0].result.content).toContain("Ignored exit_plan_mode");
      expect(toolEnds[1].name).toBe("write");
      expect(toolEnds[1].result.content).toBe("wrote");
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

    it("injects a plan-mode runtime reminder when booting in plan mode", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable system prompt",
        mode: "plan",
      });
      const metaMessages = agent.messages.filter(
        (m) => m.role === "meta" && m.kind === "system-reminder",
      );
      expect(metaMessages).toHaveLength(1);
      expect((metaMessages[0] as any).content).toContain("Plan mode is now ACTIVE");
    });

    it("appends mode runtime reminders on mode transitions", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });
      expect(agent.messages.filter((m) => m.role === "meta")).toHaveLength(0);

      agent.setMode("plan");
      let metas = agent.messages.filter((m) => m.role === "meta");
      expect(metas).toHaveLength(1);
      expect((metas[0] as any).content).toContain("Plan mode is now ACTIVE");

      agent.setMode("default");
      metas = agent.messages.filter((m) => m.role === "meta");
      expect(metas).toHaveLength(2);
      expect((metas[0] as any).content).toContain("Plan mode is now ACTIVE");
      expect((metas[1] as any).content).toContain("Permission mode is now: default");

      agent.injectModeReminder();
      metas = agent.messages.filter((m) => m.role === "meta");
      expect(metas).toHaveLength(2);
    });

    it("retires the previous mode reminder so only the current one reaches the model", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });

      // Shift+Tab cycles default → acceptEdits → plan → bypassPermissions, so
      // reaching bypass always passes through plan.
      agent.setMode("plan");
      agent.setMode("bypassPermissions");

      const metas = agent.messages.filter((m) => m.role === "meta");
      expect(metas).toHaveLength(2);
      // The transcript keeps the history...
      expect((metas[0] as any).content).toContain("Plan mode is now ACTIVE");
      expect((metas[1] as any).content).toContain("bypassPermissions");
      // ...but only the live reminder is projected to the provider.
      expect((metas[0] as any).includeInLlm).toBe(false);
      expect((metas[1] as any).includeInLlm).not.toBe(false);

      const projected = projectMessages(agent.messages);
      const planMentions = projected.filter(
        (m) => typeof m.content === "string" && m.content.includes("Plan mode is now ACTIVE"),
      );
      expect(planMentions).toHaveLength(0);
    });

    it("re-arms the mode reminder when plan mode is re-entered after being retired", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
        mode: "plan",
      });

      agent.setMode("default");
      agent.setMode("plan");

      const projected = projectMessages(agent.messages);
      const live = projected.filter(
        (m) => typeof m.content === "string" && m.content.includes("Plan mode is now ACTIVE"),
      );
      expect(live).toHaveLength(1);
      const stale = projected.filter(
        (m) => typeof m.content === "string" && m.content.includes("default Build mode"),
      );
      expect(stale).toHaveLength(0);
    });

    it("injects a bypass reminder when switching to bypassPermissions", () => {
      const agent = new Agent({
        provider: createMockProvider([]),
        model: "gpt-4o",
        tools: [],
        systemPrompt: "stable",
      });
      agent.setMode("bypassPermissions");
      const metas = agent.messages.filter((m) => m.role === "meta");
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

  it("omits enabled():false tools from the provider call and re-includes them live", async () => {
    const seenToolNames: string[][] = [];
    const provider: Provider = {
      async *streamChat(_messages, options) {
        seenToolNames.push((options.tools ?? []).map((tool) => tool.name));
        yield { type: "text", content: "ok" } as StreamChunk;
        yield { type: "done" } as StreamChunk;
      },
      async complete() {
        return "";
      },
    };
    let gateOpen = false;
    const gated: ToolRegistryEntry = {
      name: "gated_tool",
      description: "state-gated",
      parameters: { type: "object", properties: {} },
      enabled: () => gateOpen,
      async execute() {
        return { content: "ok" };
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [gated, toolForAgentTest("always_tool")] });

    await collectEvents(agent, "first", "/tmp");
    gateOpen = true;
    await collectEvents(agent, "second", "/tmp");

    expect(seenToolNames[0]).toEqual(["always_tool"]);
    expect(seenToolNames[1]).toEqual(["gated_tool", "always_tool"]);
  });
});

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
