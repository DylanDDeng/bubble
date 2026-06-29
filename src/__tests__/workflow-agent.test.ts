import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { Provider, StreamChunk } from "../types.js";

const SUMMARY = "Workflow member handoff: concrete findings with file paths. ".repeat(3);

function textProvider(summary = SUMMARY): Provider {
  return {
    async *streamChat(): AsyncGenerator<StreamChunk> {
      yield { type: "text", content: summary } satisfies StreamChunk;
      yield { type: "done" } satisfies StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

describe("Agent.runWorkflow (option C end-to-end)", () => {
  it("runs a workflow script whose agent() calls spawn real subagents and returns the script value", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const { result, agentCount, snapshots } = await agent.runWorkflow("/tmp", {
      script: `const r = await parallel([() => agent("scout a"), () => agent("scout b")]); return r.length;`,
      parentToolCallId: "wf1",
    });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: unknown }).value).toBe(2);
    expect(agentCount).toBe(2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.status === "completed")).toBe(true);
  });

  it("routes a workflow agent onto a per-call model", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const { snapshots } = await agent.runWorkflow("/tmp", {
      script: `return await agent("deep dive", { model: "anthropic:claude-opus-4-1", effort: "high" });`,
      parentToolCallId: "wf2",
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].route?.providerId).toBe("anthropic");
    expect(snapshots[0].route?.model).toBe("claude-opus-4-1");
    expect(snapshots[0].route?.thinkingLevel).toBe("high");
  });

  it("keeps workflow agents out of list_agents (workflowInternal)", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    await agent.runWorkflow("/tmp", {
      script: `return await parallel([() => agent("a"), () => agent("b")]);`,
      parentToolCallId: "wf-hide",
    });
    // The workflow's agents must not leak into the parent-facing list.
    expect(agent.listSubAgents()).toHaveLength(0);
  });

  it("runs in the background: startWorkflow returns a runId immediately, waitWorkflow collects the result", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const { runId } = agent.startWorkflow("/tmp", {
      script: `const r = await parallel([() => agent("a"), () => agent("b")]); return r.length;`,
      title: "bg test",
      parentToolCallId: "wfbg",
    });
    expect(typeof runId).toBe("string");
    // visible while running
    expect(agent.listWorkflows().some((w) => w.runId === runId)).toBe(true);
    const snap = await agent.waitWorkflow(runId, 2000);
    expect(snap?.status).toBe("completed");
    expect(snap?.result).toEqual({ ok: true, value: 2 });
    expect(snap?.agentCount).toBe(2);
    // background workflow agents stay out of the parent subagent list
    expect(agent.listSubAgents()).toHaveLength(0);
  });

  it("closeWorkflow cancels a running background workflow", async () => {
    const slow: Provider = {
      async *streamChat(): AsyncGenerator<StreamChunk> {
        await new Promise((r) => setTimeout(r, 200));
        yield { type: "text", content: SUMMARY } satisfies StreamChunk;
        yield { type: "done" } satisfies StreamChunk;
      },
      async complete() { return "complete"; },
    };
    const agent = new Agent({ provider: slow, model: "gpt-4o", tools: [] });
    const { runId } = agent.startWorkflow("/tmp", {
      script: `return await parallel([() => agent("a"), () => agent("b")]);`,
      parentToolCallId: "wfcancel",
    });
    agent.closeWorkflow(runId);
    const snap = await agent.waitWorkflow(runId, 2000);
    expect(snap?.status === "cancelled" || snap?.status === "failed").toBe(true);
  });

  it("surfaces a script-level return value (object) and a syntax error as failure", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const good = await agent.runWorkflow("/tmp", {
      script: `const a = await agent("x"); return { count: 1, first: a.slice(0, 3) };`,
      parentToolCallId: "wf3",
    });
    expect(good.result.ok).toBe(true);
    expect((good.result as { ok: true; value: any }).value.count).toBe(1);

    const bad = await agent.runWorkflow("/tmp", {
      script: `return await agent(`,
      parentToolCallId: "wf4",
    });
    expect(bad.result.ok).toBe(false);
  });
});
