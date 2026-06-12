import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentProfile } from "../agent/profiles.js";
import { WorktreeApprovalController, isPathInsideWorktree } from "../tools/child-tools.js";
import type { Provider, StreamChunk } from "../types.js";

const LONG_SUMMARY = "Handoff: I created note.txt inside the worktree, verified its contents by reading it back, and left the diff for parent review. No files outside the worktree were touched. ".repeat(2);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function writeProfile(): AgentProfile {
  return {
    name: "writer",
    description: "isolated write worker",
    source: "builtin",
    mode: "write_worktree",
    model: "inherit",
    tools: { preset: "explicit", include: ["read", "write", "bash"] },
    approval: "fail",
    prompt: "Make the requested change inside your worktree and verify it.",
  };
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

function toolCall(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: "tool_call", id, name, arguments: JSON.stringify(args), isStart: true, isEnd: true };
}

describe("write_worktree subagents (design §8)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bubble-repo-"));
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "file.txt"), "original content\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "init"]);
  });

  afterEach(() => {
    try {
      for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (line.startsWith("worktree ") && !line.includes(repo)) {
          git(repo, ["worktree", "remove", "--force", line.slice("worktree ".length)]);
        }
      }
    } catch {
      // best effort
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("lets the child write and self-verify inside its worktree while the parent tree stays byte-identical", async () => {
    const agent = new Agent({
      provider: providerFromTurns([
        [toolCall("w1", "write", { path: "note.txt", content: "from child\n" }), { type: "done" }],
        [toolCall("b1", "bash", { command: "cat note.txt" }), { type: "done" }],
        [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
    });

    const spawned = await agent.spawnSubAgent("create note.txt", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_1",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    expect(done[0].status).toBe("completed");
    const worktree = done[0].worktree!;
    expect(worktree).toBeDefined();
    expect(worktree.changed).toBe(true);
    expect(worktree.diffStat).toContain("note.txt");
    // The change exists in the worktree...
    expect(readFileSync(join(worktree.path, "note.txt"), "utf8")).toBe("from child\n");
    // ...and the parent working tree was never touched.
    expect(existsSync(join(repo, "note.txt"))).toBe(false);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("original content\n");
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
    // The handoff points the parent at the kept worktree.
    expect(done[0].toolNotes.join("\n")).toContain(worktree.path);
  });

  it("removes the worktree automatically when the child leaves no changes", async () => {
    const agent = new Agent({
      provider: providerFromTurns([
        [toolCall("r1", "read", { path: "file.txt" }), { type: "done" }],
        [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
    });

    const spawned = await agent.spawnSubAgent("just look around", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_1",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    expect(done[0].status).toBe("completed");
    const worktree = done[0].worktree!;
    expect(worktree.changed).toBe(false);
    expect(worktree.removed).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("blocks escape attempts: writes outside the worktree and denied bash operations", async () => {
    const escapePath = join(repo, "file.txt");
    const agent = new Agent({
      provider: providerFromTurns([
        [toolCall("w1", "write", { path: escapePath, content: "HACKED\n" }), { type: "done" }],
        [toolCall("b1", "bash", { command: "git push origin main" }), { type: "done" }],
        [{ type: "text", content: LONG_SUMMARY }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
    });

    const spawned = await agent.spawnSubAgent("try to escape", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_1",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    expect(done[0].status).toBe("completed");
    // The escape write never landed.
    expect(readFileSync(escapePath, "utf8")).toBe("original content\n");
    const notes = done[0].toolNotes.join("\n");
    expect(notes).toMatch(/outside the workspace|outside the subagent worktree/);
    expect(notes).toContain("Blocked by worktree policy");
  });

  it("fails with a clear error when the working directory is not a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "bubble-plain-"));
    try {
      const agent = new Agent({
        provider: providerFromTurns([[{ type: "text", content: LONG_SUMMARY }, { type: "done" }]]),
        model: "gpt-4o",
        tools: [],
      });
      const spawned = await agent.spawnSubAgent("write something", plainDir, {
        profile: writeProfile(),
        parentToolCallId: "spawn_1",
      });
      const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });
      expect(done[0].status).toBe("blocked");
      expect(done[0].error).toContain("git repository");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe("WorktreeApprovalController", () => {
  const root = "/tmp/wt-root";
  const controller = new WorktreeApprovalController(root);

  it("contains paths in code, not prompt text", () => {
    expect(isPathInsideWorktree(root, join(root, "src/a.ts"))).toBe(true);
    expect(isPathInsideWorktree(root, "/tmp/wt-root-evil/a.ts")).toBe(false);
    expect(isPathInsideWorktree(root, "../outside.txt")).toBe(false);
  });

  it("approves in-worktree file ops and rejects out-of-worktree ones", async () => {
    const inside = await controller.request({ type: "write", path: join(root, "a.ts"), content: "", fileExists: false });
    expect(inside.action).toBe("approve");
    const outside = await controller.request({ type: "write", path: "/etc/passwd", content: "", fileExists: true });
    expect(outside.action).toBe("reject");
  });

  it("auto-approves safe bash inside the worktree and rejects deny-listed commands", async () => {
    const ok = await controller.request({ type: "bash", command: "npm test", cwd: root });
    expect(ok.action).toBe("approve");
    const push = await controller.request({ type: "bash", command: "git push origin main", cwd: root });
    expect(push.action).toBe("reject");
    const outsideCwd = await controller.request({ type: "bash", command: "ls", cwd: "/somewhere/else" });
    expect(outsideCwd.action).toBe("reject");
    const escapeRef = await controller.request({ type: "bash", command: `cat /Users/someone/secret.txt`, cwd: root });
    expect(escapeRef.action).toBe("reject");
  });
});
