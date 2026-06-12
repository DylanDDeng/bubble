import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { buildDelegationPolicyPrompt } from "../prompt/delegation.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import {
  AGENT_TEAM_MIN_ITEMS,
  createAgentTeamTool,
  createSpawnAgentTool,
} from "../tools/agent-lifecycle.js";
import type { Message, Provider, StreamChunk } from "../types.js";

const PARENT_TOOLS = ["read", "grep", "spawn_agent", "wait_agent", "send_input", "close_agent", "list_agents", "agent_team"];
const CHILD_TOOLS = ["read", "glob", "grep", "lsp"];

describe("delegation policy section (system prompt)", () => {
  it("includes both the positive triggers and every negative clause for agents with delegation tools", () => {
    // Normalize whitespace so assertions survive the section's line wrapping.
    const prompt = buildSystemPrompt({ tools: PARENT_TOOLS }).replace(/\s+/g, " ");

    expect(prompt).toContain("## Delegation policy (subagents)");
    // Positive: quantified trigger (threshold 4) and team scoping.
    expect(prompt).toContain("more than four search or read operations");
    expect(prompt).toContain("same read-only investigation or analysis");
    // Briefing-quality guidance: a well-briefed child wastes no tokens searching for what the parent already knows.
    expect(prompt).toContain("self-contained work order");
    expect(prompt).toContain("Never outsource knowledge you already hold");
    expect(prompt).toContain("prefer send_input to resume it");
    // Negative clauses — the over-delegation defenses must never be lost.
    expect(prompt).toContain("requires editing files or running state-changing commands");
    expect(prompt).toContain("one or two tool calls");
    expect(prompt).toContain("fork_context is not the fix");
    expect(prompt).toContain("already read the relevant files");
    expect(prompt).toContain("Never redo delegated work locally");
    // Tie-breakers.
    expect(prompt).toContain("When in doubt about a one-off task, do it yourself");
    expect(prompt).toContain("three or more independent items");
    expect(prompt).toContain("For just two small items");
  });

  it("omits the section for tool sets without spawn_agent (child agents)", () => {
    expect(buildSystemPrompt({ tools: CHILD_TOOLS })).not.toContain("Delegation policy");
    expect(buildDelegationPolicyPrompt(CHILD_TOOLS)).toBeUndefined();
  });

  it("includes the section in the default tool set (a full parent agent)", () => {
    expect(buildSystemPrompt({})).toContain("## Delegation policy (subagents)");
  });

  it("keeps the team threshold one above the tool's hard minimum", () => {
    // The prompt steers team use to 3+ items; the tool accepts 2 as a hard
    // floor. If AGENT_TEAM_MIN_ITEMS changes, revisit the prompt wording.
    expect(AGENT_TEAM_MIN_ITEMS).toBe(2);
    expect(buildDelegationPolicyPrompt(PARENT_TOOLS)?.replace(/\s+/g, " ")).toContain("three or more independent items");
  });

  it("is static text (safe for provider prefix caching)", () => {
    expect(buildDelegationPolicyPrompt(PARENT_TOOLS)).toBe(buildDelegationPolicyPrompt(PARENT_TOOLS));
  });

  it("never reaches a real spawned child's system prompt", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "text", content: "Complete handoff with findings, conclusions, and file-level evidence. ".repeat(4) } satisfies StreamChunk;
        yield { type: "done" } satisfies StreamChunk;
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;

    const spawned = await agent.spawnSubAgent("investigate", "/tmp", { profile, parentToolCallId: "spawn_1" });
    await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 2_000 });

    const record = (agent as any).subagentStore.get(spawned.agentId);
    const childSystem = (record.agent.messages as Message[]).find((message) => message.role === "system");
    expect(childSystem).toBeDefined();
    expect(childSystem!.content).not.toContain("Delegation policy");
  });
});

describe("delegation wording in tool descriptions", () => {
  it("spawn_agent uses the proactive framing with the explicit-request override and briefing guidance", () => {
    // No cwd → the dynamic profile lister contributes nothing; assertions are hermetic.
    const tool = createSpawnAgentTool();

    expect(tool.description).toContain("Proactively delegate multi-file investigations");
    expect(tool.description).toContain("unless the user explicitly asks for a subagent");
    expect(tool.description).toContain("self-contained work order");
    // The old passive framing must stay deleted.
    expect(tool.description).not.toContain("When the user asks to use a subagent");
    // The anti-duplication rule survives the rewrite.
    expect(tool.description).toContain("do not duplicate the same delegated work locally");
  });

  it("agent_team scopes its proactive clause to read-only operations and keeps the exclusivity rule", () => {
    const tool = createAgentTeamTool();

    expect(tool.description).toContain("Proactively use this when a task naturally splits into the same read-only operation");
    expect(tool.description).toContain("must be the ONLY tool call");
  });
});

describe("task-start delegation nudge", () => {
  it("adds the nudge to repo orientation only when the agent can delegate", () => {
    const withDelegation = reminderForTaskType("repo_orientation", { canDelegate: true });
    expect(withDelegation).toContain("delegate to a background subagent (spawn_agent)");
    expect(withDelegation).toContain("same read-only question over several independent items");

    const withoutDelegation = reminderForTaskType("repo_orientation", { canDelegate: false });
    expect(withoutDelegation).toBeDefined();
    expect(withoutDelegation).not.toContain("spawn_agent");

    const defaultCall = reminderForTaskType("repo_orientation");
    expect(defaultCall).not.toContain("spawn_agent");
  });

  it("does not add the nudge to implementation or debugging turns", () => {
    for (const taskType of ["implementation", "debugging"] as const) {
      const reminder = reminderForTaskType(taskType, { canDelegate: true });
      expect(reminder).toBeDefined();
      expect(reminder).not.toContain("spawn_agent");
    }
  });
});
