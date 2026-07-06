import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { discoverAgentProfiles, findAgentProfile, type AgentProfile } from "../agent/profiles.js";
import type { Message, Provider, StreamChunk } from "../types.js";

const FIRST_SUMMARY = "First-run conclusion: the admission gate covers every launch path including restarts and team members.";
const SECOND_SUMMARY = "Follow-up conclusion: persistence round-trips finalReason and deliveredAt across restarts.";

function defaultProfile(): AgentProfile {
  return findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
}

function providerFromTurns(turns: StreamChunk[][]): Provider {
  let index = 0;
  return {
    async *streamChat() {
      for (const chunk of turns[index++] ?? []) {
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
}

describe("subagent persistence and cross-restart resume (design §7)", () => {
  let persistDir: string;

  beforeEach(() => {
    persistDir = mkdtempSync(join(tmpdir(), "bubble-subagents-"));
  });

  afterEach(() => {
    rmSync(persistDir, { recursive: true, force: true });
  });

  it("persists a completed child and resumes it in a new process via send_input with context intact", async () => {
    const firstAgent = new Agent({
      provider: providerFromTurns([[{ type: "text", content: FIRST_SUMMARY }, { type: "done" }]]),
      model: "gpt-4o",
      tools: [],
      subagents: { persistDir },
    });
    const spawned = await firstAgent.spawnSubAgent("investigate the scheduler", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "spawn_1",
    });
    await firstAgent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    const files = readdirSync(persistDir);
    expect(files).toContain(`${spawned.agentId}.json`);

    // "Restart": a brand-new Agent over the same persist dir.
    const secondAgent = new Agent({
      provider: providerFromTurns([[{ type: "text", content: SECOND_SUMMARY }, { type: "done" }]]),
      model: "gpt-4o",
      tools: [],
      subagents: { persistDir },
    });

    const listed = secondAgent.listSubAgents();
    expect(listed.map((snapshot) => snapshot.agentId)).toContain(spawned.agentId);
    expect(listed[0].status).toBe("completed");
    expect(listed[0].summary).toBe(FIRST_SUMMARY);

    const resumed = await secondAgent.sendSubAgentInput(spawned.agentId, "continue the investigation", "/tmp");
    expect(resumed.agentId).toBe(spawned.agentId);
    const done = await secondAgent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });
    expect(done[0].status).toBe("completed");
    expect(done[0].summary).toBe(SECOND_SUMMARY);

    // Context intact: the resumed child history contains both exchanges.
    const record = (secondAgent as any).subagentStore.get(spawned.agentId);
    const messages = record.agent.messages as Message[];
    const userContents = messages.filter((message) => message.role === "user").map((message) => message.content);
    expect(userContents).toContain("investigate the scheduler");
    expect(userContents).toContain("continue the investigation");
    expect(messages.some((message) => message.role === "assistant" && message.content === FIRST_SUMMARY)).toBe(true);
  });

  it("round-trips finalReason, resumable, and deliveredAt through the on-disk schema", async () => {
    const failingProvider: Provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error("provider exploded");
      },
      async complete() {
        return "complete";
      },
    };
    const firstAgent = new Agent({
      provider: failingProvider,
      model: "gpt-4o",
      tools: [],
      subagents: { persistDir },
    });
    const spawned = await firstAgent.spawnSubAgent("doomed", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "spawn_1",
    });
    const waited = await firstAgent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });
    expect(waited[0].finalReason).toBe("failed_transient");

    const raw = JSON.parse(readFileSync(join(persistDir, `${spawned.agentId}.json`), "utf8"));
    expect(raw.finalReason).toBe("failed_transient");
    expect(raw.deliveredAt).toBeDefined();

    const secondAgent = new Agent({
      provider: failingProvider,
      model: "gpt-4o",
      tools: [],
      subagents: { persistDir },
    });
    const reloaded = secondAgent.listSubAgents().find((snapshot) => snapshot.agentId === spawned.agentId)!;
    expect(reloaded.finalReason).toBe("failed_transient");
    expect(reloaded.resumable).toBe(true);
    expect(reloaded.deliveredAt).toBeDefined();
  });

  it("in-memory records win over stale disk entries", async () => {
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "text", content: FIRST_SUMMARY }, { type: "done" }],
        [{ type: "text", content: SECOND_SUMMARY }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
      subagents: { persistDir },
    });
    const spawned = await agent.spawnSubAgent("task", "/tmp", { profile: defaultProfile(), parentToolCallId: "s1" });
    await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });
    await agent.sendSubAgentInput(spawned.agentId, "again", "/tmp");
    await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    // The store kept exactly one record for the child across both runs.
    expect(agent.listSubAgents().filter((snapshot) => snapshot.agentId === spawned.agentId)).toHaveLength(1);
    expect(agent.listSubAgents()[0].summary).toBe(SECOND_SUMMARY);
  });
});
