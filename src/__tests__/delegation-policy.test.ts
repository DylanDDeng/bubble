import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { buildDelegationPolicyPrompt } from "../prompt/delegation.js";
import { orchestrationRequestReminder, reminderForTaskType } from "../prompt/task-reminders.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import { createRunWorkflowTool, createSpawnAgentTool } from "../tools/agent-lifecycle.js";
import type { Message, Provider, StreamChunk } from "../types.js";

const PARENT_TOOLS = ["read", "grep", "spawn_agent", "wait_agent", "send_input", "close_agent", "list_agents", "run_workflow"];
const CHILD_TOOLS = ["read", "glob", "grep", "lsp"];

describe("delegation policy section (system prompt)", () => {
  it("includes both the positive triggers and every negative clause for agents with delegation tools", () => {
    // Normalize whitespace so assertions survive the section's line wrapping.
    const prompt = buildSystemPrompt({ tools: PARENT_TOOLS }).replace(/\s+/g, " ");

    expect(prompt).toContain("## Delegation policy (subagents)");
    // Positive: quantified trigger (threshold 4) and team scoping.
    expect(prompt).toContain("more than four search or read operations");
    expect(prompt).toContain("fans out over many independent items");
    // The fan-out choice is taught as a judgment call with explicit criteria,
    // not a hard rule: both paths stay legitimate, the tradeoffs decide.
    expect(prompt).toContain("Choose by shape, not by rule");
    expect(prompt).toContain("favor spawn_agent");
    expect(prompt).toContain("favor a run_workflow script");
    // The explicit-request rule must be a standalone top-of-section clause,
    // not buried mid-bullet: a sentence hidden in a paragraph lost to the
    // model's "agent team = parallel spawns" prior in live testing.
    expect(prompt).toContain("Explicit requests win, before any other rule");
    expect(prompt).toContain("an agent team");
    expect(prompt).toContain("NOT a row of");
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

  it("steers fan-out to three or more items (two small items stay inline)", () => {
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
    expect(tool.description).toContain("weigh run_workflow instead");
    expect(tool.description).toContain("unless the user explicitly asks for a subagent");
    expect(tool.description).toContain("self-contained work order");
    // The old passive framing must stay deleted.
    expect(tool.description).not.toContain("When the user asks to use a subagent");
    // The anti-duplication rule survives the rewrite.
    expect(tool.description).toContain("do not duplicate the same delegated work locally");
  });

  it("run_workflow covers fan-out over many subagents and keeps the exclusivity rule", () => {
    const tool = createRunWorkflowTool();

    expect(tool.description).toContain("coordinates many subagents");
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

describe("explicit orchestration request detector (harness-level)", () => {
  it("fires on the exact live-test phrasings that prompt wording failed to route", () => {
    const positives = [
      "启动agent team，从性能、可玩性、代码质量三个角度评价一下 gomoku-mcts.html",
      "run a workflow to inspect this repo",
      "帮我编排几个子代理把这些文件都看一遍",
      "用工作流并行评审这些 demo",
      "fan out agents to audit every module",
      "起一个 agent 团队来做这件事",
    ];
    for (const input of positives) {
      const reminder = orchestrationRequestReminder(input, true);
      expect(reminder, input).toBeDefined();
      expect(reminder).toContain("ONE run_workflow call");
      expect(reminder).toContain("Do not substitute parallel spawn_agent calls");
    }
  });

  it("stays silent on ordinary requests and on delegation without a named mechanism", () => {
    const negatives = [
      "把这个目录下的 HTML demo 都看一遍，每个给点改进建议",
      "spawn a subagent to check the scheduler",
      "从三个角度评价一下 gomoku-mcts.html",
      "帮我修一下这个 bug",
    ];
    for (const input of negatives) {
      expect(orchestrationRequestReminder(input, true), input).toBeUndefined();
    }
  });

  it("never fires when run_workflow is not in the tool set (child agents)", () => {
    expect(orchestrationRequestReminder("run a workflow please", false)).toBeUndefined();
  });
});
