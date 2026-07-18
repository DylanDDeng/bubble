import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../approval/types.js";
import { FileStateTracker } from "../file-state.js";
import { createWriteTool } from "../write.js";

describe("write tool", () => {
  const tmpDir = join(tmpdir(), "bubble-test-write-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("writes a new file", async () => {
    const tracker = new FileStateTracker(tmpDir);
    const tool = createWriteTool(tmpDir, {}, undefined, undefined, tracker);
    const result = await tool.execute(
      { path: "new.txt", content: "hello" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(tmpDir, "new.txt"), "utf-8")).toBe("hello");
  });

  it("overwrites an existing file without a separate overwrite flag", async () => {
    const file = join(tmpDir, "existing.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const tool = createWriteTool(tmpDir, {}, undefined, undefined, tracker);
    const result = await tool.execute(
      { path: "existing.txt", content: "new" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Updated");
    expect(readFileSync(file, "utf-8")).toBe("new");
  });

  it("blocks overwriting when the file changes while approval is pending", async () => {
    const file = join(tmpDir, "changed-during-approval.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const approvalRequests: ApprovalRequest[] = [];
    const write = createWriteTool(tmpDir, {}, {
      checkRules: () => ({ decision: "ask" }),
      request: async (request) => {
        approvalRequests.push(request);
        writeFileSync(file, "external change", "utf-8");
        return { action: "approve" };
      },
    }, undefined, tracker);

    const result = await write.execute(
      { path: "changed-during-approval.txt", content: "new" },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("changed while approval was pending");
    expect(readFileSync(file, "utf-8")).toBe("external change");
    expect(approvalRequests).toHaveLength(1);
  });

  it("allows another full write after this session created the file", async () => {
    const file = join(tmpDir, "created-then-overwritten.txt");
    const tracker = new FileStateTracker(tmpDir);
    const write = createWriteTool(tmpDir, {}, undefined, undefined, tracker);

    const first = await write.execute(
      { path: "created-then-overwritten.txt", content: "first" },
      { cwd: tmpDir },
    );
    const second = await write.execute(
      { path: "created-then-overwritten.txt", content: "second" },
      { cwd: tmpDir },
    );

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("second");
  });

  it("escalates outside-workspace paths to the approval controller instead of hard-blocking", async () => {
    const outside = join(tmpdir(), "bubble-outside-write-test.txt");
    writeFileSync(outside, "outside", "utf-8");

    const approvalRequests: ApprovalRequest[] = [];
    const rejecting = createWriteTool(tmpDir, {}, {
      checkRules: () => ({ decision: "ask" as const }),
      request: async (request: ApprovalRequest) => {
        approvalRequests.push(request);
        return { action: "reject" as const };
      },
    });
    const rejected = await rejecting.execute(
      { path: resolve(outside), content: "changed" },
      { cwd: tmpDir },
    );

    expect(rejected.isError).toBe(true);
    expect(readFileSync(outside, "utf-8")).toBe("outside");
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ type: "write", outsideWorkspace: true });

    const approving = createWriteTool(tmpDir, {}, {
      checkRules: () => ({ decision: "ask" as const }),
      request: async () => ({ action: "approve" as const }),
    });
    const approved = await approving.execute(
      { path: resolve(outside), content: "changed" },
      { cwd: tmpDir },
    );

    expect(approved.isError).toBeUndefined();
    expect(readFileSync(outside, "utf-8")).toBe("changed");
  });

  it("does not flag workspace paths as outside the workspace", async () => {
    const approvalRequests: ApprovalRequest[] = [];
    const write = createWriteTool(tmpDir, {}, {
      checkRules: () => ({ decision: "ask" as const }),
      request: async (request: ApprovalRequest) => {
        approvalRequests.push(request);
        return { action: "approve" as const };
      },
    });
    await write.execute({ path: "inside.txt", content: "hi" }, { cwd: tmpDir });

    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ type: "write", outsideWorkspace: false });
  });
});
