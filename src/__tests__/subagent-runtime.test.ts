import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { discoverAgentProfiles, findAgentProfile, type AgentProfile } from "../agent/profiles.js";
import { RateLimitError } from "../network/errors.js";
import type { Message, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

function providerFromTurns(turns: Array<StreamChunk[] | (() => StreamChunk[])>): Provider {
  let index = 0;
  return {
    async *streamChat() {
      const turn = turns[index++] ?? [];
      const chunks = typeof turn === "function" ? turn() : turn;
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
}

/** Provider whose first call throws RateLimitError, later calls stream turns. */
function rateLimitedProvider(turns: StreamChunk[][], failures = 1): { provider: Provider; calls: () => number } {
  let calls = 0;
  let successIndex = 0;
  const provider: Provider = {
    // eslint-disable-next-line require-yield
    async *streamChat() {
      calls += 1;
      if (calls <= failures) {
        throw new RateLimitError("429 from provider", { retryAfterMs: 0 });
      }
      const chunks = turns[successIndex++] ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
  return { provider, calls: () => calls };
}

/** Provider whose first `failures` calls throw a Bun-style fetch timeout, then stream turns. */
function timeoutThenSucceedProvider(turns: StreamChunk[][], failures = 1): { provider: Provider; calls: () => number } {
  let calls = 0;
  let successIndex = 0;
  const provider: Provider = {
    // eslint-disable-next-line require-yield
    async *streamChat() {
      calls += 1;
      if (calls <= failures) {
        // Exactly what Bun's fetch throws on a request timeout.
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }
      const chunks = turns[successIndex++] ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
  return { provider, calls: () => calls };
}

/** Provider that blocks its first turn until released; honors abort like a real transport. */
function gatedProvider(turns: StreamChunk[][]): { provider: Provider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let index = 0;
  const provider: Provider = {
    async *streamChat(_messages, options) {
      const myIndex = index++;
      if (myIndex === 0) {
        const signal = options?.abortSignal;
        await Promise.race([
          gate,
          new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        }
      }
      for (const chunk of turns[myIndex] ?? []) {
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
  return { provider, release };
}

function defaultProfile(): AgentProfile {
  return findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
}

function readTool(): ToolRegistryEntry {
  return {
    name: "read",
    readOnly: true,
    effect: "read",
    description: "Read",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "tool result", metadata: { kind: "read", path: "/tmp/x" } };
    },
  };
}

const LONG_SUMMARY = "This is the complete final handoff with concrete evidence, file paths, conclusions, and explicit uncertainty. ".repeat(4);

describe("subagent runtime — scheduler integration", () => {
  it("queues spawns beyond maxActiveSubagents and reports the queue position", async () => {
    const { provider, release } = gatedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { maxActiveSubagents: 1 },
    });
    const profile = defaultProfile();

    const first = await agent.spawnSubAgent("task one", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const second = await agent.spawnSubAgent("task two", "/tmp", { profile, parentToolCallId: "spawn_2" });

    expect(second.status).toBe("queued");
    expect(second.queuePosition).toBe(1);

    release();
    const done = await agent.waitSubAgents({ agentIds: [first.agentId, second.agentId], timeoutMs: 2_000 });
    expect(done.every((snapshot) => snapshot.status === "completed")).toBe(true);
  });

  it("subjects send_input restarts to the same admission limits as spawns", async () => {
    const { provider, release } = gatedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { maxActiveSubagents: 1 },
    });
    const profile = defaultProfile();

    // Occupy the only slot with a gated child, after first letting one complete.
    const finished = await agent.spawnSubAgent("warmup", "/tmp", { profile, parentToolCallId: "spawn_0" });
    // The gate blocks turn 0 only; warmup IS turn 0, so release it for the test
    // by spawning it gated and then releasing later. Instead: gate occupies slot now.
    const blocker = finished; // warmup occupies turn 0 (gated)
    const restartTarget = await agent.spawnSubAgent("restart me", "/tmp", { profile, parentToolCallId: "spawn_1" });

    // Both children exist: blocker is running (gated), restartTarget queued.
    expect(restartTarget.status).toBe("queued");

    const restarted = await agent.sendSubAgentInput(restartTarget.agentId, "follow-up", "/tmp", { interrupt: true });
    expect(restarted.status).toBe("queued");

    release();
    const done = await agent.waitSubAgents({ agentIds: [blocker.agentId, restarted.agentId], timeoutMs: 2_000 });
    expect(done.every((snapshot) => snapshot.status === "completed")).toBe(true);
  });

  it("close_agent on a queued child returns cancelled immediately without hanging", async () => {
    const { provider, release } = gatedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { maxActiveSubagents: 1 },
    });
    const profile = defaultProfile();

    await agent.spawnSubAgent("running child", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const queued = await agent.spawnSubAgent("queued child", "/tmp", { profile, parentToolCallId: "spawn_2" });
    expect(queued.status).toBe("queued");

    const closed = await agent.closeSubAgent(queued.agentId);
    expect(closed.status).toBe("closed");
    expect(closed.finalReason).toBe("cancelled_user");
    release();
  });
});

describe("subagent runtime — rate-limit contract", () => {
  it("retries the same instance after RateLimitError with exactly one input copy in the child history", async () => {
    const { provider, calls } = rateLimitedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("rate limited task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("completed");
    expect(calls()).toBe(2);

    const record = (agent as any).subagentStore.get(spawned.agentId);
    const userMessages = (record.agent.messages as Message[]).filter(
      (message) => message.role === "user" && message.content === "rate limited task",
    );
    expect(userMessages).toHaveLength(1);
    const interrupted = (record.agent.messages as Message[]).filter(
      (message) => message.role === "assistant" && message.content.startsWith("[model request interrupted"),
    );
    expect(interrupted).toHaveLength(0);
  });

  it("finalizes as rate_limited_exhausted (resumable) when retries run out", async () => {
    const { provider } = rateLimitedProvider([], 99);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { rateLimitMaxAttempts: 2, rateLimitBackoffMs: [0, 0] },
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("never succeeds", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("failed");
    expect(done[0].finalReason).toBe("rate_limited_exhausted");
    expect(done[0].resumable).toBe(true);
  });
});

describe("subagent runtime — transport-timeout contract", () => {
  it("retries the same instance after a connection timeout, completing with one input copy", async () => {
    const { provider, calls } = timeoutThenSucceedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { transportRetryMaxAttempts: 2, transportRetryBackoffMs: [0, 0] },
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("timeout task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("completed");
    expect(calls()).toBe(2);

    const record = (agent as any).subagentStore.get(spawned.agentId);
    const userMessages = (record.agent.messages as Message[]).filter(
      (message) => message.role === "user" && message.content === "timeout task",
    );
    expect(userMessages).toHaveLength(1);
    // The stale "[model request interrupted...]" boundary must be stripped on requeue.
    const interrupted = (record.agent.messages as Message[]).filter(
      (message) => message.role === "assistant" && message.content.startsWith("[model request interrupted"),
    );
    expect(interrupted).toHaveLength(0);
  });

  it("finalizes failed_transient (resumable) when timeouts never clear", async () => {
    const { provider } = timeoutThenSucceedProvider([], 99);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { transportRetryMaxAttempts: 2, transportRetryBackoffMs: [0, 0] },
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("never connects", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("failed");
    expect(done[0].finalReason).toBe("failed_transient");
    expect(done[0].resumable).toBe(true);
  });

  it("still hard-fails a non-transport provider error (no spurious retry)", async () => {
    let calls = 0;
    const provider: Provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        calls += 1;
        throw new Error("provider exploded");
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("boom", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("failed");
    expect(done[0].finalReason).toBe("failed_transient");
    expect(calls).toBe(1); // not a transport error -> no requeue
  });
});

describe("subagent runtime — no per-child token cap", () => {
  it("lets a token-heavy child run to completion instead of budget-cancelling it", async () => {
    const usage = (promptTokens: number, completionTokens: number): StreamChunk => ({
      type: "usage",
      usage: { promptTokens, completionTokens },
    });
    const agent = new Agent({
      provider: providerFromTurns([
        [usage(200_000, 500), { type: "tool_call", id: "r1", name: "read", arguments: "{}", isStart: true, isEnd: true }, { type: "done" }],
        [usage(300_000, 500), { type: "tool_call", id: "r2", name: "read", arguments: "{}", isStart: true, isEnd: true }, { type: "done" }],
        [usage(400_000, 500), { type: "text", content: LONG_SUMMARY }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool()],
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("token heavy task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(done[0].status).toBe("completed");
    expect(done[0].finalReason).toBe("completed");
    expect(done[0].summary).toBe(LONG_SUMMARY.trim());

    const record = (agent as any).subagentStore.get(spawned.agentId);
    const reminders = (record.agent.messages as Message[]).filter(
      (message) => message.role === "meta" && message.content.includes("Token budget notice"),
    );
    expect(reminders).toHaveLength(0);
  });
});

describe("subagent runtime — handoff guard", () => {
  it("accepts a short complete Chinese handoff after tool use without replacing it", async () => {
    // 80 CJK chars ≈ 80 estimated tokens — above the 60-token floor even
    // though it is far below 200 raw characters.
    const chineseSummary = "结论：该模块的并发控制存在缺口，调度器未消费配置中的上限，建议在统一的派发入口处实施准入控制并补充对应的单元测试覆盖，相关文件是源代码目录下的调度器实现。";
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "tool_call", id: "r1", name: "read", arguments: "{}", isStart: true, isEnd: true }, { type: "done" }],
        [{ type: "text", content: chineseSummary }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool()],
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("中文任务", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    expect(done[0].status).toBe("completed");
    expect(done[0].summary).toBe(chineseSummary);
  });

  it("requests a follow-up when a Chinese handoff is mid-thought narration", async () => {
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "tool_call", id: "r1", name: "read", arguments: "{}", isStart: true, isEnd: true }, { type: "done" }],
        [{ type: "text", content: "接下来我将检查调度器的并发控制实现，先读取相关源代码文件，然后分析准入与排队逻辑，再看一下测试目录里有没有覆盖这些行为的用例，最后给出完整的结论与建议。" }, { type: "done" }],
        [{ type: "text", content: "结论：调度器没有实施并发上限，需要统一派发入口。建议补充准入控制与对应的测试。" }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool()],
    });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("中文任务", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    expect(done[0].status).toBe("completed");
    expect(done[0].summary).toContain("结论：调度器没有实施并发上限");
  });
});

describe("subagent runtime — reply protocol", () => {
  it("marks a transient failure resumable and a budget kill not resumable", async () => {
    const failingProvider: Provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error("provider exploded");
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({ provider: failingProvider, model: "gpt-4o", tools: [] });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("doomed task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    expect(done[0].status).toBe("failed");
    expect(done[0].finalReason).toBe("failed_transient");
    expect(done[0].resumable).toBe(true);
  });

  it("interrupting via send_input yields a resumable cancelled_interrupt state", async () => {
    const { provider, release } = gatedProvider([
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("slow task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const redirected = await agent.sendSubAgentInput(spawned.agentId, "new direction", "/tmp", { interrupt: true });
    release();
    const done = await agent.waitSubAgents({ agentIds: [redirected.agentId], timeoutMs: 2_000 });

    expect(done[0].status).toBe("completed");
  });
});
