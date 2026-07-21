import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import type { AgentEvent, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

// The completion self-check gate (default-hooks afterTurn): when a run that
// changed code is about to end, remind the model ONCE to re-read the original
// request. Regression-locks the four guards: single-fire latch, codeChanged
// gating, forceTextOnly mutex (covered via latch semantics), subagent
// exemption.

function providerFromTurns(turns: StreamChunk[][], onCall?: () => void): Provider {
  let index = 0;
  return {
    async *streamChat() {
      onCall?.();
      const chunks = turns[index++] ?? [{ type: "text", content: "fallback final answer" }];
      for (const chunk of chunks) yield chunk;
      yield { type: "done" };
    },
    async complete() {
      return "complete";
    },
  };
}

function fakeWriteTool(): ToolRegistryEntry {
  return {
    name: "write",
    description: "write a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() {
      return {
        content: "ok",
        isError: false,
        metadata: { kind: "write", path: "/tmp/x" },
      };
    },
  } as unknown as ToolRegistryEntry;
}

function writeCallTurn(seq = 1): StreamChunk[] {
  return [
    { type: "tool_call", id: `w${seq}`, name: "write", arguments: "", isStart: true, isEnd: false },
    { type: "tool_call", id: `w${seq}`, name: "write", arguments: "", argumentsFull: '{"path":"/tmp/x"}', isStart: false, isEnd: true },
  ];
}

function textTurn(content: string): StreamChunk[] {
  return [{ type: "text", content }];
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("completion self-check gate", () => {
  it("fires exactly once after code changes: final turn continues, next final turn ends the run", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [
          writeCallTurn(),               // turn 1: writes a file (codeChanged)
          textTurn("all done"),          // turn 2: tries to finish -> gate fires
          textTurn("confirmed, final"),  // turn 3: finishes for real
        ],
        () => providerCalls++,
      ),
      model: "test-model",
      tools: [fakeWriteTool()],
    });

    const events = await collect(agent.run("change the file", process.cwd()));

    // Three model calls: the gate bought exactly one extra turn.
    expect(providerCalls).toBe(3);
    const turnEnds = events.filter((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
    // The gated turn is marked willContinue; the last one is not.
    expect(turnEnds.at(-2)?.willContinue).toBe(true);
    expect(turnEnds.at(-1)?.willContinue).toBe(false);
    // The self-check reminder landed in resident history as a meta message.
    const reminderInHistory = agent.messages.some((m) =>
      m.role === "meta" && m.content.includes("re-read the user's original request"));
    expect(reminderInHistory).toBe(true);
  });

  it("does not fire on runs that never changed code", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns([textTurn("the answer is 42")], () => providerCalls++),
      model: "test-model",
      tools: [fakeWriteTool()],
    });

    await collect(agent.run("what is 6*7?", process.cwd()));

    expect(providerCalls).toBe(1);
  });

  it("fires via git ground truth when files are written through a shell-kind tool", async () => {
    // codeChanged metadata stays false (kind "shell"), but the git baseline
    // sees the new file — the gate must still fire, and the reminder must
    // disclose the modified pre-existing test.
    const dir = mkdtempSync(join(tmpdir(), "bubble-gate-git-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
    git("init", "-q");
    git("config", "user.email", "t@t.local");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "app.test.ts"), "assert one\nassert two\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    const shellWriteTool: ToolRegistryEntry = {
      name: "bash",
      description: "run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      async execute() {
        // Simulates `sed -i` weakening an existing test: deletes an assertion.
        writeFileSync(join(dir, "app.test.ts"), "assert one\n");
        return { content: "ok", isError: false, metadata: { kind: "shell" } };
      },
    } as unknown as ToolRegistryEntry;

    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [
          [
            { type: "tool_call", id: "b1", name: "bash", arguments: "", isStart: true, isEnd: false },
            { type: "tool_call", id: "b1", name: "bash", arguments: "", argumentsFull: '{"command":"sed -i ..."}', isStart: false, isEnd: true },
          ],
          textTurn("done"),
          textTurn("final"),
        ],
        () => providerCalls++,
      ),
      model: "test-model",
      tools: [shellWriteTool],
    });

    await collect(agent.run("tweak the tests", dir));

    // Gate bought one extra turn despite codeChanged never being set.
    expect(providerCalls).toBe(3);
    const reminder = agent.messages.find((m) =>
      m.role === "meta" && m.content.includes("modified pre-existing test files"));
    expect(reminder).toBeDefined();
    expect(reminder!.content).toContain("app.test.ts");
    expect(reminder!.content).toContain("1 line removed");
  });

  it("re-arms the gate for a steered follow-up request", async () => {
    const inputController = new AgentRunInputQueue();
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [
          writeCallTurn(1),          // turn 1: write (codeChanged)
          textTurn("done with A"),   // gate #1 fires -> continuation
          textTurn("confirmed A"),   // steer applied before... (queue drains at turn boundaries)
          writeCallTurn(2),          // follow-up work
          textTurn("done with B"),   // gate #2 (re-armed by steer) -> continuation
          textTurn("confirmed B"),
        ],
        () => {
          providerCalls++;
          if (providerCalls === 2) inputController.enqueue("also update B");
        },
      ),
      model: "test-model",
      tools: [fakeWriteTool()],
    });

    await collect(agent.run("update A", process.cwd(), { inputController }));

    const gateReminders = agent.messages.filter((m) =>
      m.role === "meta" && m.content.includes("You appear to be finishing"));
    expect(gateReminders.length).toBe(2);
  });

  it("does not fire for subagents", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [writeCallTurn(), textTurn("done")],
        () => providerCalls++,
      ),
      model: "test-model",
      tools: [fakeWriteTool()],
      agentRole: "subagent",
    });

    await collect(agent.run("change the file", process.cwd()));

    // write turn + final text turn, no extra gated turn.
    expect(providerCalls).toBe(2);
  });
});
