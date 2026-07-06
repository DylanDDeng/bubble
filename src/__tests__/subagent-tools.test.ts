import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalController, ApprovalRequest } from "../approval/types.js";
import { createListAgentsTool, createSpawnAgentTool, createWaitAgentTool } from "../tools/agent-lifecycle.js";
import type { ToolContext } from "../types.js";
import type { SubagentThreadSnapshot } from "../agent/subagent-control.js";

function snapshot(partial: Partial<SubagentThreadSnapshot>): SubagentThreadSnapshot {
  return {
    agentId: "child_1",
    runId: "run_1",
    nickname: "Ada",
    agentName: "default",
    profileSource: "builtin",
    status: "completed",
    task: "inspect",
    summary: "",
    toolNotes: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function approvalStub(action: "approve" | "reject"): { controller: ApprovalController; requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    controller: {
      async request(req) {
        requests.push(req);
        return { action };
      },
      checkRules() {
        return { decision: "ask" };
      },
    },
  };
}

describe("list_agents", () => {
  it("lists subagents with status and queue position", async () => {
    const tool = createListAgentsTool();
    const ctx: ToolContext = {
      cwd: "/tmp",
      agent: {
        async runSubtask() {
          return { content: "unused" };
        },
        listSubAgents: () => [
          snapshot({ agentId: "a", status: "running", task: "look around" }),
          snapshot({ agentId: "b", status: "queued", queuePosition: 2, nickname: "Grace" }),
          snapshot({ agentId: "c", status: "closed" }),
        ],
      },
    };
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("2 subagents");
    expect(result.content).toContain("agent_id=a status=running");
    expect(result.content).toContain("queue_position=2");
    expect(result.content).not.toContain("agent_id=c");

    const filtered = await tool.execute({ status_filter: ["queued"] }, ctx);
    expect(filtered.content).toContain("agent_id=b");
    expect(filtered.content).not.toContain("agent_id=a");
  });
});

describe("spawn_agent reply protocol", () => {
  it("uses queue-aware wording for a queued child instead of demanding wait_agent", async () => {
    const tool = createSpawnAgentTool();
    const ctx: ToolContext = {
      cwd: "/tmp",
      toolCall: { id: "spawn_1", name: "spawn_agent" },
      agent: {
        async runSubtask() {
          return { content: "unused" };
        },
        async spawnSubAgent() {
          return snapshot({ status: "queued", queuePosition: 3 });
        },
      },
    };
    const result = await tool.execute({ message: "inspect" }, ctx);
    expect(result.content).toContain("queued: waiting for a concurrency slot behind 2 children");
    expect(result.content).toContain("starts automatically");
    expect(result.content).not.toContain("next: call wait_agent for");
  });
});

describe("wait_agent reply protocol (design §3.1, §3.4)", () => {
  function waitCtx(snapshots: SubagentThreadSnapshot[]): ToolContext {
    return {
      cwd: "/tmp",
      agent: {
        async runSubtask() {
          return { content: "unused" };
        },
        waitSubAgents: async () => snapshots,
      },
    };
  }

  it("renders the resume line iff the runtime judged the run resumable", async () => {
    const tool = createWaitAgentTool();

    const transient = await tool.execute({}, waitCtx([
      snapshot({ status: "failed", finalReason: "failed_transient", resumable: true, error: "provider exploded" }),
    ]));
    expect(transient.content).toContain("resume: call send_input with agent_id child_1");

    const blocked = await tool.execute({}, waitCtx([
      snapshot({ status: "blocked", finalReason: "blocked", resumable: false, error: "approval required" }),
    ]));
    expect(blocked.content).toContain("re-spawn with an adjusted profile");
    expect(blocked.content).not.toContain("resume: call send_input");
  });

  it("branches timeout wording on queued vs running and never emits a resume hint", async () => {
    const tool = createWaitAgentTool();
    const result = await tool.execute({}, waitCtx([
      snapshot({ agentId: "q", status: "queued", queuePosition: 2 }),
      snapshot({ agentId: "r", status: "running" }),
    ]));

    expect(result.status).toBe("timeout");
    expect(result.content).toContain("queued for a concurrency slot");
    expect(result.content).toContain("still running");
    expect(result.content).toContain("wait_agent again with a longer timeout");
    expect(result.content).not.toContain("resume: call send_input");
  });
});

describe("project profile trust gate", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "bubble-trust-"));
    const agentsDir = join(projectDir, ".bubble", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "scout.md"), [
      "---",
      "name: scout",
      "description: project scout profile",
      "---",
      "You are the project scout.",
    ].join("\n"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function spawnCtx(): ToolContext {
    return {
      cwd: projectDir,
      toolCall: { id: "spawn_1", name: "spawn_agent" },
      agent: {
        async runSubtask() {
          return { content: "unused" };
        },
        async spawnSubAgent() {
          return snapshot({ status: "queued" });
        },
      },
    };
  }

  it("blocks project profiles when no approval flow is available (fail closed)", async () => {
    const tool = createSpawnAgentTool({ cwd: projectDir });
    const result = await tool.execute({ message: "go", agent_type: "scout" }, spawnCtx());
    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("needs the user's approval");
  });

  it("asks the user once and remembers the approval for the same content hash", async () => {
    const { controller, requests } = approvalStub("approve");
    const tool = createSpawnAgentTool({ cwd: projectDir, approval: controller });

    const first = await tool.execute({ message: "go", agent_type: "scout" }, spawnCtx());
    expect(first.isError).toBeFalsy();
    const second = await tool.execute({ message: "go again", agent_type: "scout" }, spawnCtx());
    expect(second.isError).toBeFalsy();

    expect(requests).toHaveLength(1);
    expect(requests[0].type).toBe("agent_profile");
    if (requests[0].type === "agent_profile") {
      expect(requests[0].name).toBe("scout");
      expect(requests[0].promptPreview).toContain("project scout");
    }
  });

  it("re-prompts after the profile file changes (content hash key)", async () => {
    const { controller, requests } = approvalStub("approve");
    const tool = createSpawnAgentTool({ cwd: projectDir, approval: controller });
    await tool.execute({ message: "go", agent_type: "scout" }, spawnCtx());

    writeFileSync(join(projectDir, ".bubble", "agents", "scout.md"), [
      "---",
      "name: scout",
      "description: project scout profile",
      "---",
      "You are the EDITED project scout.",
    ].join("\n"));

    await tool.execute({ message: "go again", agent_type: "scout" }, spawnCtx());
    expect(requests).toHaveLength(2);
  });

  it("blocks when the user rejects", async () => {
    const { controller } = approvalStub("reject");
    const tool = createSpawnAgentTool({ cwd: projectDir, approval: controller });
    const result = await tool.execute({ message: "go", agent_type: "scout" }, spawnCtx());
    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("declined to trust");
  });

  it("exposes custom profile descriptions to the model via the tool description", () => {
    const tool = createSpawnAgentTool({ cwd: projectDir });
    expect(tool.description).toContain("scout");
    expect(tool.description).toContain("[project: requires user approval on first use]");
    expect(tool.description).toContain("project scout profile");
  });
});
