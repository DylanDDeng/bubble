/**
 * setSessionID must repoint the subagent persist directory
 * (docs/known-defects.md #2) — the TUI reuses one Agent instance across
 * session switches, so the store has to follow the session.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentProfile } from "../agent/profiles.js";
import type { Provider, StreamChunk } from "../types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bubble-session-switch-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function defaultProfile(): AgentProfile {
  return {
    name: "default",
    description: "general worker",
    source: "builtin",
    mode: "readonly",
    model: "inherit",
    tools: { preset: "readonly" },
    approval: "fail",
    prompt: "Do the task.",
  };
}

function textProvider(text: string): Provider {
  return {
    async *streamChat() {
      yield { type: "text", content: text } as StreamChunk;
      yield { type: "done" } as StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

async function spawnAndFinish(agent: Agent, task: string): Promise<string> {
  const spawned = await agent.spawnSubAgent(task, "/tmp", {
    profile: defaultProfile(),
    parentToolCallId: `spawn_${task.replace(/\W+/g, "_")}`,
  });
  await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });
  return spawned.agentId;
}

describe("setSessionID repoints the subagent persist dir", () => {
  it("persists post-switch children into the NEW session's directory", async () => {
    const home = makeHome();
    const sessionA = join(home, "session-a.jsonl");
    const sessionB = join(home, "session-b.jsonl");
    writeFileSync(sessionA, "");
    writeFileSync(sessionB, "");

    const agent = new Agent({
      provider: textProvider("done. summary of work."),
      model: "gpt-4o",
      sessionID: sessionA,
      tools: [],
    });
    agent.setSessionID(sessionB);
    await spawnAndFinish(agent, "task after switch");

    const dirA = join(home, "session-a.subagents");
    const dirB = join(home, "session-b.subagents");
    expect(existsSync(dirA) ? readdirSync(dirA).length : 0).toBe(0);
    expect(readdirSync(dirB).length).toBeGreaterThan(0);
  });

  it("surfaces the new session's persisted children and evicts the old session's", async () => {
    const home = makeHome();
    const sessionA = join(home, "session-a.jsonl");
    const sessionB = join(home, "session-b.jsonl");
    writeFileSync(sessionA, "");
    writeFileSync(sessionB, "");

    // Seed session B's directory with a finished child from a "previous process".
    const seeder = new Agent({
      provider: textProvider("B's child summary."),
      model: "gpt-4o",
      sessionID: sessionB,
      tools: [],
    });
    const bChildId = await spawnAndFinish(seeder, "b task");

    // Fresh agent on session A: spawn a child there, then switch to B.
    const agent = new Agent({
      provider: textProvider("A's child summary."),
      model: "gpt-4o",
      sessionID: sessionA,
      tools: [],
    });
    const aChildId = await spawnAndFinish(agent, "a task");
    expect(agent.listSubAgents().map((s) => s.agentId)).toContain(aChildId);

    agent.setSessionID(sessionB);
    const afterSwitch = agent.listSubAgents().map((s) => s.agentId);
    // B's persisted child is now visible; A's finished child no longer
    // pollutes B's list (it stays reloadable by switching back).
    expect(afterSwitch).toContain(bChildId);
    expect(afterSwitch).not.toContain(aChildId);

    // Round-trip: switching back to A restores A's child and drops B's.
    agent.setSessionID(sessionA);
    const backOnA = agent.listSubAgents().map((s) => s.agentId);
    expect(backOnA).toContain(aChildId);
    expect(backOnA).not.toContain(bChildId);
  });

  it("keeps an explicitly configured persistDir across session switches", async () => {
    const home = makeHome();
    const explicitDir = join(home, "explicit-subagents");
    const sessionA = join(home, "session-a.jsonl");
    const sessionB = join(home, "session-b.jsonl");
    writeFileSync(sessionA, "");
    writeFileSync(sessionB, "");

    const agent = new Agent({
      provider: textProvider("done."),
      model: "gpt-4o",
      sessionID: sessionA,
      tools: [],
      subagents: { persistDir: explicitDir },
    });
    agent.setSessionID(sessionB);
    await spawnAndFinish(agent, "explicit dir task");

    expect(readdirSync(explicitDir).length).toBeGreaterThan(0);
    expect(existsSync(join(home, "session-b.subagents"))).toBe(false);
  });

  it("setSessionID(undefined) disables persistence without crashing", async () => {
    const home = makeHome();
    const sessionA = join(home, "session-a.jsonl");
    writeFileSync(sessionA, "");

    const agent = new Agent({
      provider: textProvider("done."),
      model: "gpt-4o",
      sessionID: sessionA,
      tools: [],
    });
    agent.setSessionID(undefined);
    await spawnAndFinish(agent, "no session task");

    expect(existsSync(join(home, "session-a.subagents"))).toBe(false);
  });

  it("is a no-op on subagent-role agents", () => {
    const agent = new Agent({
      provider: textProvider("done."),
      model: "gpt-4o",
      tools: [],
      agentRole: "subagent",
    });
    // Children never persist for subagent roles; switching must not create a store dir.
    expect(() => agent.setSessionID("/tmp/whatever.jsonl")).not.toThrow();
  });
});

describe("workflowInternal persistence gate (known-defects #5)", () => {
  it("store.persist refuses workflow-internal records even via markDelivered", async () => {
    const home = makeHome();
    const sessionA = join(home, "session-a.jsonl");
    writeFileSync(sessionA, "");

    const agent = new Agent({
      provider: textProvider("member summary."),
      model: "gpt-4o",
      sessionID: sessionA,
      tools: [],
    });
    const store = (agent as any).subagentStore;

    // Simulate what executeWorkflow does: a workflowInternal record that
    // reaches a final state and then gets markDelivered (runtime.ts calls
    // store.markDelivered for every completed member).
    const record = {
      agentId: "wf-member-1",
      runId: "run-1",
      nickname: "wf-member",
      profile: defaultProfile(),
      workflowInternal: true,
      parentToolCallId: "run_workflow_1",
      parentToolName: "run_workflow",
      status: "completed",
      task: "internal member task",
      summary: "done",
      toolNotes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      abortController: new AbortController(),
      waiters: new Set(),
    };
    store.set(record);
    store.markDelivered("wf-member-1");

    const dirA = join(home, "session-a.subagents");
    const persisted = existsSync(dirA) ? readdirSync(dirA) : [];
    expect(persisted).not.toContain("wf-member-1.json");
  });
});
