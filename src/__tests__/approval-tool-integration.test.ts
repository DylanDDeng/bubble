import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import { createBashTool } from "../tools/bash.js";
import { createEditTool } from "../tools/edit.js";
import { createWriteTool } from "../tools/write.js";
import type { ApprovalController, ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { PermissionMode } from "../types.js";

function makeApproval(decisionFor: (req: ApprovalRequest) => ApprovalDecision): {
  controller: ApprovalController;
  requests: ApprovalRequest[];
} {
  const requests: ApprovalRequest[] = [];
  return {
    controller: {
      request: async (req) => {
        requests.push(req);
        return decisionFor(req);
      },
      checkRules: () => ({ decision: "ask" }),
    },
    requests,
  };
}

function makeModeApproval(
  cwd: string,
  mode: PermissionMode,
  handler?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): ApprovalController {
  return new PermissionAwareApprovalController({
    getMode: () => mode,
    handlerRef: handler ? { current: handler } : {},
    cwd,
  });
}

describe("edit tool with ApprovalController", () => {
  it("skips writing when the user rejects, and surfaces the feedback to the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-edit-reject-"));
    const path = join(dir, "a.txt");
    writeFileSync(path, "alpha beta", "utf-8");

    const { controller, requests } = makeApproval(() => ({ action: "reject", feedback: "do it differently" }));
    const tool = createEditTool(dir, controller);
    const result = await tool.execute(
      { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
      { cwd: dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
    expect(result.content).toContain("do it differently");
    expect(readFileSync(path, "utf-8")).toBe("alpha beta"); // unchanged
    expect(requests).toHaveLength(1);
    expect(requests[0].type).toBe("edit");
    if (requests[0].type === "edit") {
      expect(requests[0].diff).toContain("-alpha beta");
      expect(requests[0].diff).toContain("+ALPHA beta");
    }
  });

  it("applies the edit when approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-edit-approve-"));
    const path = join(dir, "a.txt");
    writeFileSync(path, "alpha beta", "utf-8");

    const { controller } = makeApproval(() => ({ action: "approve" }));
    const tool = createEditTool(dir, controller);
    const result = await tool.execute(
      { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
      { cwd: dir },
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf-8")).toBe("ALPHA beta");
  });
});

describe("write tool with ApprovalController", () => {
  it("does not write when the user rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-write-reject-"));
    const path = join(dir, "new.txt");
    const { controller, requests } = makeApproval(() => ({ action: "reject" }));
    const tool = createWriteTool(dir, {}, controller);
    const result = await tool.execute(
      { path: "new.txt", content: "hi" },
      { cwd: dir },
    );
    expect(result.isError).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(requests[0].type).toBe("write");
    if (requests[0].type === "write") {
      expect(requests[0].fileExists).toBe(false);
      expect(requests[0].diff).toContain("+hi");
    }
  });

  it("writes when approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-write-approve-"));
    const path = join(dir, "new.txt");
    const { controller } = makeApproval(() => ({ action: "approve" }));
    const tool = createWriteTool(dir, {}, controller);
    const result = await tool.execute(
      { path: "new.txt", content: "hi" },
      { cwd: dir },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Wrote 1 lines");
    expect(readFileSync(path, "utf-8")).toBe("hi");
  });
});

describe("bash tool with ApprovalController", () => {
  it("does not execute when rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-reject-"));
    const sentinel = join(dir, "sentinel.txt");
    const { controller, requests } = makeApproval(() => ({ action: "reject", feedback: "nope" }));
    const tool = createBashTool(dir, controller);
    const result = await tool.execute(
      { command: `touch ${JSON.stringify(sentinel)}` },
      { cwd: dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
    expect(result.content).toContain("nope");
    // If the command had run, stdout/stderr prefixes would appear in the tool output;
    // because approval gated it, the command never executed.
    expect(result.content).not.toContain("stdout:");
    expect(existsSync(sentinel)).toBe(false);
    expect(requests[0]).toEqual(expect.objectContaining({ type: "bash" }));
  });

  it("runs the command when approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-approve-"));
    const { controller } = makeApproval(() => ({ action: "approve" }));
    const tool = createBashTool(dir, controller);
    const result = await tool.execute({ command: "echo hi-from-bash" }, { cwd: dir });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hi-from-bash");
  });

  it("deletes a workspace file directly in bypassPermissions mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-rm-bypass-"));
    const path = join(dir, "snake.html");
    writeFileSync(path, "<html></html>", "utf-8");
    const handler = vi.fn(async () => ({ action: "reject" }) as ApprovalDecision);

    const tool = createBashTool(dir, makeModeApproval(dir, "bypassPermissions", handler));
    const result = await tool.execute({ command: "rm snake.html" }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect(existsSync(path)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("asks before deleting a workspace file in default Build mode and honors approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-rm-default-approve-"));
    const path = join(dir, "snake.html");
    writeFileSync(path, "<html></html>", "utf-8");
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);

    const tool = createBashTool(dir, makeModeApproval(dir, "default", handler));
    const result = await tool.execute({ command: "rm snake.html" }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect(existsSync(path)).toBe(false);
    expect(handler).toHaveBeenCalledWith({ type: "bash", command: "rm snake.html", cwd: dir });
  });

  it("does not delete a workspace file in default Build mode when rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-rm-default-reject-"));
    const path = join(dir, "snake.html");
    writeFileSync(path, "<html></html>", "utf-8");

    const tool = createBashTool(
      dir,
      makeModeApproval(dir, "default", async () => ({ action: "reject", feedback: "do not delete it" })),
    );
    const result = await tool.execute({ command: "rm snake.html" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
    expect(result.content).toContain("do not delete it");
    expect(readFileSync(path, "utf-8")).toBe("<html></html>");
  });

  it("rejects workspace file deletion in plan mode before the shell runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-bash-rm-plan-"));
    const path = join(dir, "snake.html");
    writeFileSync(path, "<html></html>", "utf-8");

    const tool = createBashTool(dir, makeModeApproval(dir, "plan"));
    const result = await tool.execute({ command: "rm snake.html" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Plan mode");
    expect(result.content).toContain("exit_plan_mode");
    expect(readFileSync(path, "utf-8")).toBe("<html></html>");
  });
});
