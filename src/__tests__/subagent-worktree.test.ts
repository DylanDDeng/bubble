import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentProfile } from "../agent/profiles.js";
import { WorktreeApprovalController, isPathInsideWorktree } from "../tools/child-tools.js";
import { RateLimitError } from "../network/errors.js";
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
    // Reclaimed: the unchanged worktree is removed AND the record's reference
    // is cleared, so a later resume rebuilds a fresh worktree instead of
    // running inside a deleted directory. The main checkout must be the only
    // registered worktree left.
    expect(done[0].worktree).toBeUndefined();
    const registered = git(repo, ["worktree", "list", "--porcelain"]);
    expect(registered.match(/^worktree /gm)).toHaveLength(1);
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

describe("worktree reclamation at scheduler-terminal outcomes (known-defects #1)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bubble-reclaim-repo-"));
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "file.txt"), "original content\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "init"]);
  });

  afterEach(() => {
    // Force-drop any kept child worktrees (bubble-wt-* only: the repo itself
    // shows under /private/var while mkdtemp reported /var) so the tmpdir rm
    // succeeds.
    for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
      const path = line.startsWith("worktree ") ? line.slice("worktree ".length) : undefined;
      if (path && path.includes("bubble-wt-")) {
        try { git(repo, ["worktree", "remove", "--force", path]); } catch { /* already gone */ }
        rmSync(path, { recursive: true, force: true });
      }
    }
    rmSync(repo, { recursive: true, force: true });
  });

  const onlyMainCheckout = () =>
    git(repo, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)!;

  it("reclaims an unchanged worktree when rate-limit retries run out", async () => {
    const provider: Provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new RateLimitError("429 from provider", { retryAfterMs: 0 });
      },
      async complete() { return "complete"; },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { rateLimitMaxAttempts: 2, rateLimitBackoffMs: [0, 0] },
    });

    const spawned = await agent.spawnSubAgent("never succeeds", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_exhaust",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    expect(done[0].finalReason).toBe("rate_limited_exhausted");
    // Attempt 1 created a worktree (the 429 comes from the model call, after
    // instance creation); exhaustion must reclaim it — directory removed,
    // git registration gone, record reference cleared.
    expect(done[0].worktree).toBeUndefined();
    expect(onlyMainCheckout()).toHaveLength(1);
  });

  it("keeps a changed worktree on exhaustion, with exactly one handoff note", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        if (calls === 1) {
          const chunk: StreamChunk = toolCall("w1", "write", { path: "note.txt", content: "work in progress\n" });
          yield chunk;
          yield { type: "done" } as StreamChunk;
          return;
        }
        throw new RateLimitError("429 from provider", { retryAfterMs: 0 });
      },
      async complete() { return "complete"; },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { rateLimitMaxAttempts: 2, rateLimitBackoffMs: [0, 0] },
    });

    const spawned = await agent.spawnSubAgent("write then stall", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_changed",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    expect(done[0].finalReason).toBe("rate_limited_exhausted");
    // Changed → kept for review; the note must appear exactly once even
    // though reclaim is reachable from more than one terminal path.
    const worktree = done[0].worktree!;
    expect(worktree.changed).toBe(true);
    expect(existsSync(worktree.path)).toBe(true);
    const notes = done[0].toolNotes.filter((note) => note.startsWith("worktree:"));
    expect(notes).toHaveLength(1);
  });

  it("reclaims the worktree when an abort lands during retry backoff", async () => {
    let firstCall: (() => void) | undefined;
    const calledOnce = new Promise<void>((resolve) => { firstCall = resolve; });
    const provider: Provider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        firstCall?.();
        firstCall = undefined;
        throw new RateLimitError("429 from provider", { retryAfterMs: 60_000 });
      },
      async complete() { return "complete"; },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { rateLimitMaxAttempts: 3, rateLimitBackoffMs: [60_000, 60_000] },
    });
    const controller = new AbortController();

    const spawned = await agent.spawnSubAgent("aborted in backoff", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_backoff",
      abortSignal: controller.signal,
    });
    await calledOnce;                                  // attempt 1 ran → worktree exists
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the requeue settle
    controller.abort(new Error("user abort"));
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });

    // Cancelled while re-queued: attempt 1 already created the worktree, so
    // this cancel path MUST reclaim (the "run never started" assumption is
    // false for retry re-entries).
    expect(done[0].status).toBe("cancelled");
    expect(done[0].worktree).toBeUndefined();
    expect(onlyMainCheckout()).toHaveLength(1);
  });

  it("resume after reclamation rebuilds a fresh worktree with the history carried over", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        if (calls <= 2) {
          // Exactly what Bun's fetch throws on a request timeout.
          throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
        }
        yield { type: "text", content: LONG_SUMMARY } as StreamChunk;
        yield { type: "done" } as StreamChunk;
      },
      async complete() { return "complete"; },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { transportRetryMaxAttempts: 2, transportRetryBackoffMs: [0, 0] },
    });

    const spawned = await agent.spawnSubAgent("the original task", repo, {
      profile: writeProfile(),
      parentToolCallId: "spawn_transient",
    });
    const done = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 10_000 });
    expect(done[0].finalReason).toBe("failed_transient");
    expect(done[0].worktree).toBeUndefined();          // reclaimed (unchanged)

    // failed_transient is resumable: the reuse guard must rebuild a fresh
    // worktree (the old instance's tools are fenced to the deleted dir) and
    // carry the conversation over.
    const resumed = await agent.sendSubAgentInput(spawned.agentId, "please continue", repo, {});
    await agent.waitSubAgents({ agentIds: [resumed.agentId], timeoutMs: 10_000 });

    const record = (agent as any).subagentStore.get(spawned.agentId);
    expect(record.status).toBe("completed");
    const history = (record.agent.messages as Array<{ role: string; content: string }>)
      .map((message) => message.content).join("\n");
    expect(history).toContain("the original task");
    // The resumed run left no changes, so its fresh worktree was reclaimed
    // again — nothing may linger in the registry either way.
    expect(record.worktree).toBeUndefined();
    expect(onlyMainCheckout()).toHaveLength(1);
  });
});
