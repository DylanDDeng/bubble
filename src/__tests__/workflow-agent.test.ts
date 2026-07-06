import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { buildWorkflowDeliveryNotice } from "../agent/workflow/control.js";
import { createAgentLifecycleTools } from "../tools/agent-lifecycle.js";
import type { AgentEvent, Provider, StreamChunk } from "../types.js";

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

describe("run_workflow exclusivity", () => {
  it("blocks run_workflow when it shares a response with other tool calls, with a teaching message", async () => {
    const provider: Provider = (() => {
      let turn = 0;
      return {
        async *streamChat(): AsyncGenerator<StreamChunk> {
          turn += 1;
          if (turn === 1) {
            yield { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true } satisfies StreamChunk;
            yield {
              type: "tool_call",
              id: "wf_1",
              name: "run_workflow",
              arguments: JSON.stringify({ script: "return 1;" }),
              isStart: true,
              isEnd: true,
            } satisfies StreamChunk;
            yield { type: "done" } satisfies StreamChunk;
            return;
          }
          yield { type: "text", content: "done" } satisfies StreamChunk;
          yield { type: "done" } satisfies StreamChunk;
        },
        async complete() {
          return "complete";
        },
      };
    })();

    const readTool = {
      name: "read",
      readOnly: true,
      effect: "read" as const,
      description: "Read",
      parameters: { type: "object" as const, properties: {} },
      async execute() {
        return { content: "tool result" };
      },
    };
    const workflowTool = createAgentLifecycleTools({ cwd: "/tmp" }).find((tool) => tool.name === "run_workflow")!;
    const agent = new Agent({ provider, model: "gpt-4o", tools: [readTool, workflowTool] });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("go", "/tmp")) {
      events.push(event);
    }

    const workflowEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end" && event.name === "run_workflow",
    );
    expect(workflowEnd).toBeDefined();
    expect(workflowEnd!.result.isError).toBe(true);
    expect(workflowEnd!.result.content).toContain("must be the only tool call");
    const readEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end" && event.name === "read",
    );
    expect(readEnd!.result.isError).toBeFalsy();
  });
});

describe("run_workflow project-profile trust gate", () => {
  it("blocks a workflow agent whose profile the trust gate rejects, without running it", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const out = await agent.runWorkflow("/tmp", {
      script: `const r = await agent("audit x").catch((e) => "blocked: " + String(e));\nreturn r;`,
      parentToolCallId: "wf_trust",
      ensureProfileTrusted: async () => ({ content: "Blocked: profile needs the user's approval" }),
    });
    expect(out.result.ok).toBe(true);
    expect(String((out.result as { ok: true; value: unknown }).value)).toContain("profile needs the user's approval");
    expect(out.snapshots.every((snapshot) => snapshot.status !== "completed")).toBe(true);
  });

  it("the run_workflow tool wires ensureProfileTrusted into startWorkflow", async () => {
    const workflowTool = createAgentLifecycleTools({ cwd: "/tmp" }).find((tool) => tool.name === "run_workflow")!;
    let captured: any;
    const ctx = {
      cwd: "/tmp",
      toolCall: { id: "wf_1", name: "run_workflow" },
      agent: {
        startWorkflow: (_cwd: string, options: any) => {
          captured = options;
          return { runId: "wf_x", title: "t" };
        },
      },
    } as any;
    const result = await workflowTool.execute({ script: "return 1;" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(typeof captured.ensureProfileTrusted).toBe("function");
  });
});

describe("workflow delivery notice", () => {
  it("warns about members that did not complete so null slots are not read as done", () => {
    const snapshot = {
      runId: "wf_1",
      title: "audit",
      status: "completed",
      agentCount: 2,
      result: { ok: true, value: ["a"] },
      logs: [],
      snapshots: [
        { nickname: "Ada", status: "completed" },
        { nickname: "Bob", status: "failed", error: "provider exploded" },
      ],
    } as any;
    const notice = buildWorkflowDeliveryNotice(snapshot);
    expect(notice).toContain("1 of 2 agents did not complete");
    expect(notice).toContain("Bob (failed: provider exploded)");
    expect(notice).toContain("returned null");
  });

  it("emits no warning when every member completed", () => {
    const snapshot = {
      runId: "wf_2",
      title: "audit",
      status: "completed",
      agentCount: 1,
      result: { ok: true, value: "x" },
      logs: [],
      snapshots: [{ nickname: "Ada", status: "completed" }],
    } as any;
    expect(buildWorkflowDeliveryNotice(snapshot)).not.toContain("did not complete");
  });
});
