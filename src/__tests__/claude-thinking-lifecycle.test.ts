import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent.js";
import { SessionManager } from "../session.js";
import { buildAnthropicRequest, createAnthropicMessagesProvider, translateAnthropicStream } from "../provider-anthropic.js";
import { checkpointMessages, createContextCheckpoint } from "../context/checkpoint.js";
import { projectMessages } from "../context/projector.js";
import { aggressivePruneMessages } from "../context/prune.js";
import type { AgentEvent, AssistantMessage, Message, Provider, ProviderRawContentBlock, StreamChunk, ToolRegistryEntry } from "../types.js";

const models = ["claude-opus-5-5", "claude-fable-5-1"];
const options = { providerId: "anthropic", apiKey: "fixture", baseURL: "https://api.anthropic.com" };
const reminder = '<bubble_internal_reminder kind="system-reminder">Read before editing.</bubble_internal_reminder>';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-claude-thinking-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  return { dir, file, manager: new SessionManager(file) };
}

function rawBlocks(id: string): ProviderRawContentBlock[] {
  return [
    { type: "thinking", thinking: "", signature: `sig-empty-${id}` },
    { type: "text", text: `Reading. ${reminder}` },
    { type: "thinking", thinking: `I recall ${reminder}`, signature: `sig-reminder-${id}` },
    { type: "redacted_thinking", data: `encrypted-${id}` },
    { type: "tool_use", id, name: "read", input: {} },
  ];
}

async function* response(id: string): AsyncGenerator<StreamChunk> {
  async function* events() {
    for (const [index, content_block] of rawBlocks(id).entries()) {
      yield { type: "content_block_start", index, content_block };
      yield { type: "content_block_stop", index };
    }
  }
  yield* translateAnthropicStream(events());
  yield { type: "done" };
}

function assistant(model: string, id: string): AssistantMessage {
  return {
    role: "assistant", content: "Reading.", reasoning: "Visible reasoning",
    modelId: model, model: `anthropic:${model}`, providerId: "anthropic",
    toolCalls: [{ id, name: "read", arguments: "{}" }],
    providerMetadata: { anthropic: { contentBlocks: rawBlocks(id) } },
  };
}

async function run(agent: Agent, input: string, cwd: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(input, cwd)) events.push(event);
  return events;
}

describe.each(models)("%s signed thinking lifecycle", model => {
  it.each([true, false])("sends binding controls with the required beta header (stream=%s)", async streaming => {
    const transformations = [{ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "private-path-fixture", signature: "private-signature-fixture" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("anthropic-beta")?.split(",")).toEqual(["user-beta", "thinking-binding-controls-2026-08-01"]);
      const body = JSON.parse(String(init?.body));
      expect(body.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
      expect(body.model).toBe(model);
      if (!streaming) return new Response(JSON.stringify({ content: [{ type: "text", text: "Done" }], input_transformations: transformations }));
      return new Response([
        { type: "message_start", message: { input_transformations: transformations } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const provider = createAnthropicMessagesProvider({ ...options, headers: { "Anthropic-Beta": "user-beta" } });
    if (streaming) {
      const chunks = [];
      for await (const chunk of provider.streamChat([{ role: "user", content: "Hi" }], { model })) chunks.push(chunk);
      expect(chunks.some(chunk => chunk.type === "text" && chunk.content === "Done")).toBe(true);
    } else {
      expect(await provider.complete([{ role: "user", content: "Hi" }], { model })).toBe("Done");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[anthropic-thinking] API discarded 1 thinking block(s) after a conversation prefix change.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
  });

  it("preserves wire blocks through real Agent append, disk restore and a follow-up turn", async () => {
    const { dir, file, manager } = fixture();
    let requests = 0;
    let executions = 0;
    const tool: ToolRegistryEntry = {
      name: "read", description: "Read", parameters: { type: "object", properties: {} },
      async execute() { executions++; return { content: "file data" }; },
    };
    const provider: Provider = {
      async *streamChat(messages, chat) {
        requests++;
        if (requests === 1) { yield* response("a"); return; }
        const body = buildAnthropicRequest(options, messages, chat);
        const recorded = body.messages.find(message => message.role === "assistant");
        expect(recorded?.content).toEqual(rawBlocks("a"));
        const disk = new SessionManager(file);
        const storedEntry = disk.getEntries().find(entry => entry.type === "assistant_message");
        expect(storedEntry?.type).toBe("assistant_message");
        if (storedEntry?.type !== "assistant_message") throw new Error("Missing persisted reply");
        const stored = storedEntry.message;
        expect(stored.providerMetadata?.anthropic?.contentBlocks).toEqual(rawBlocks("a"));
        expect(stored.content).not.toContain("bubble_internal_");
        expect(stored.reasoning).not.toContain("bubble_internal_");
        // The session loader intentionally hides an unfinished user turn until
        // its final answer commits. Inspect restored messages on the next turn.
        if (requests > 2) {
          const restoredBody = buildAnthropicRequest(options, projectMessages(disk.getMessages()), chat);
          expect(restoredBody.messages.find(message => message.role === "assistant")?.content).toEqual(rawBlocks("a"));
        }
        yield { type: "text", content: "Done." };
        yield { type: "done" };
      },
      async complete() { return "unused"; },
    };
    const makeAgent = () => new Agent({ provider, model: `anthropic:${model}`, providerId: "anthropic", tools: [tool],
      onMessageAppend: message => manager.appendMessage(message) });
    const agent = makeAgent();
    const events = await run(agent, "Read", dir);
    expect(requests).toBe(2);
    expect(executions).toBe(1);
    const visible = events.filter(e => e.type === "text_delta" || e.type === "reasoning_delta").map(e => e.content).join("");
    expect(visible).not.toContain("bubble_internal_");
    expect(readFileSync(file, "utf8")).toContain("sig-reminder-a");
    const resumed = makeAgent();
    resumed.messages = new SessionManager(file).getMessages();
    await run(resumed, "Continue", dir);
    expect(requests).toBe(3);
    expect(executions).toBe(1);
  });

  it.each(["auto", "manual", "overflow", "resident"] as const)("invalidates all bound blocks at a %s checkpoint and repairs older checkpoints", reason => {
    const history: Message[] = [{ role: "user", content: "Read" }, assistant(model, "a"),
      { role: "tool", toolCallId: "a", content: "x".repeat(2000) }, assistant(model, "b"),
      { role: "tool", toolCallId: "b", content: "last result" }];
    const original = JSON.stringify(history);
    const candidate = aggressivePruneMessages(history);
    expect(candidate[2].content).not.toBe(history[2].content);
    const cp = createContextCheckpoint(candidate, reason);
    const { file, manager } = fixture();
    manager.commitContextCheckpoint(cp);
    const restored = new SessionManager(file).getMessages();
    for (const messages of [cp.messages, restored, checkpointMessages({ ...cp, messages: candidate })]) {
      const body = buildAnthropicRequest(options, projectMessages(messages), { model });
      expect(JSON.stringify(body)).not.toContain('"signature"');
      expect(JSON.stringify(body)).not.toContain('"redacted_thinking"');
      expect(messages.filter(m => m.role === "tool")).toHaveLength(2);
      expect(messages.filter(m => m.role === "assistant").every(m => m.reasoning === "Visible reasoning")).toBe(true);
      expect(JSON.stringify(body)).toContain("last result");
    }
    expect(JSON.stringify(history)).toBe(original);
    // A newly produced signature belongs to the new prefix and must survive a restart.
    manager.appendMessage(assistant(model, "fresh"));
    manager.appendMessage({ role: "tool", toolCallId: "fresh", content: "fresh result" });
    const next = buildAnthropicRequest(options, projectMessages(new SessionManager(file).getMessages()), { model });
    expect(JSON.stringify(next)).toContain("sig-reminder-fresh");
    expect(JSON.stringify(next)).not.toContain("sig-reminder-b");
  });

  it("recovers a real Agent tool loop from overflow without stale signatures or repeated tool execution", async () => {
    const { dir, file, manager } = fixture();
    let requests = 0;
    let executions = 0;
    const tool: ToolRegistryEntry = {
      name: "read", description: "Read", parameters: { type: "object", properties: {} },
      async execute() { executions++; return { content: executions === 1 ? "data ".repeat(2000) : "small result" }; },
    };
    const provider: Provider = {
      async *streamChat(messages, chat) {
        requests++;
        if (requests <= 2) { yield* response(String(requests)); return; }
        const body = JSON.stringify(buildAnthropicRequest(options, messages, chat));
        if (requests === 3) {
          expect(body).toContain("sig-reminder-2");
          throw new Error("400 context_length_exceeded: prompt too long");
        }
        expect(body).not.toContain("sig-reminder-1");
        expect(body).not.toContain("sig-reminder-2");
        if (requests === 4) {
          expect(body).not.toContain('"signature"');
          expect(messages.filter(m => m.role === "tool")).toHaveLength(2);
          yield* response("fresh"); return;
        }
        expect(body).toContain("sig-reminder-fresh");
        yield { type: "text", content: "Recovered." };
        yield { type: "done" };
      },
      async complete() { return "unused"; },
    };
    const agent = new Agent({ provider, model: `anthropic:${model}`, providerId: "anthropic", tools: [tool],
      onMessageAppend: message => manager.appendMessage(message),
      onContextCheckpoint: cp => manager.commitContextCheckpoint(cp),
      getContextRevision: () => manager.getRevision(),
    });
    const events = await run(agent, "Read", dir);
    expect(requests).toBe(5);
    expect(executions).toBe(3);
    expect(events.some(event => event.type === "context_recovered")).toBe(true);
    const body = JSON.stringify(buildAnthropicRequest(options, projectMessages(new SessionManager(file).getMessages()), { model }));
    expect(body).toContain("sig-reminder-fresh");
    expect(body).not.toContain("sig-reminder-2");
    // Full original history remains on disk for display and audit.
    expect(readFileSync(file, "utf8")).toContain("sig-reminder-2");
  });
});
