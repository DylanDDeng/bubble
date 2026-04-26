import { describe, expect, it, vi } from "vitest";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import { buildRuleSet } from "../permissions/rule.js";
import type { PermissionMode } from "../types.js";

function makeController(mode: PermissionMode, handler?: (req: ApprovalRequest) => Promise<ApprovalDecision>) {
  const handlerRef: { current?: (req: ApprovalRequest) => Promise<ApprovalDecision> } = {};
  if (handler) handlerRef.current = handler;
  return new PermissionAwareApprovalController({
    getMode: () => mode,
    handlerRef,
    cwd: "/tmp/bubble-test",
  });
}

const EDIT_REQ: ApprovalRequest = { type: "edit", path: "/tmp/f.ts", diff: "diff", fileExists: true };
const WRITE_REQ: ApprovalRequest = { type: "write", path: "/tmp/new.ts", content: "hi", fileExists: false };
const BASH_REQ: ApprovalRequest = { type: "bash", command: "ls", cwd: "/tmp" };
const LSP_REQ: ApprovalRequest = { type: "lsp", path: "/tmp/bubble-test/src/a.ts", operation: "hover" };

describe("PermissionAwareApprovalController", () => {
  it("auto-approves every request in bypassPermissions", async () => {
    const c = makeController("bypassPermissions");
    expect(await c.request(EDIT_REQ)).toEqual({ action: "approve" });
    expect(await c.request(WRITE_REQ)).toEqual({ action: "approve" });
    expect(await c.request(BASH_REQ)).toEqual({ action: "approve" });
  });

  it("auto-approves every request in dontAsk", async () => {
    const c = makeController("dontAsk");
    expect(await c.request(BASH_REQ)).toEqual({ action: "approve" });
  });

  it("auto-approves edit/write in acceptEdits but still asks for bash", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const handlerRef = { current: handler };
    const c = new PermissionAwareApprovalController({
      getMode: () => "acceptEdits",
      handlerRef,
      cwd: "/tmp/bubble-test",
    });

    expect(await c.request(EDIT_REQ)).toEqual({ action: "approve" });
    expect(await c.request(WRITE_REQ)).toEqual({ action: "approve" });
    expect(handler).not.toHaveBeenCalled();

    expect(await c.request(BASH_REQ)).toEqual({ action: "approve" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects non-readonly tools in plan mode with a feedback message", async () => {
    const c = makeController("plan");
    const result = await c.request(BASH_REQ);
    expect(result.action).toBe("reject");
    expect(result.feedback).toContain("Plan mode");
    expect(result.feedback).toContain("exit_plan_mode");
  });

  it("delegates to the UI handler in default mode", async () => {
    const handler = vi.fn(async () => ({ action: "approve", feedback: "go" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
    });
    const result = await c.request(BASH_REQ);
    expect(result).toEqual({ action: "approve", feedback: "go" });
    expect(handler).toHaveBeenCalledWith(BASH_REQ);
  });

  it("rejects safely when default mode has no UI handler attached (e.g. --print mode)", async () => {
    const c = makeController("default");
    const result = await c.request(BASH_REQ);
    expect(result.action).toBe("reject");
    expect(result.feedback).toContain("No interactive UI");
  });

  it("allow rule skips the UI prompt", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet(["Bash(git status)"], []),
    });
    expect((await c.request({ type: "bash", command: "git status", cwd: "/tmp" })).action).toBe("approve");
    expect(handler).not.toHaveBeenCalled();
  });

  it("Lsp allow rule skips the UI prompt", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet(["Lsp(./src/**)"], []),
    });

    expect((await c.request(LSP_REQ)).action).toBe("approve");
    expect(handler).not.toHaveBeenCalled();
  });

  it("deny rule rejects with a citation", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Bash(rm -rf:*)"]),
    });
    const result = await c.request({ type: "bash", command: "rm -rf /tmp/x", cwd: "/tmp" });
    expect(result.action).toBe("reject");
    expect(result.feedback).toContain("deny rule");
    expect(result.feedback).toContain("Bash(rm -rf:*)");
    expect(handler).not.toHaveBeenCalled();
  });

  it("deny wins over allow when both match", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: async () => ({ action: "approve" }) },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet(["Bash"], ["Bash(rm -rf:*)"]),
    });
    const ok = await c.request({ type: "bash", command: "ls", cwd: "/tmp" });
    expect(ok.action).toBe("approve");
    const bad = await c.request({ type: "bash", command: "rm -rf /tmp/x", cwd: "/tmp" });
    expect(bad.action).toBe("reject");
  });

  it("checkRules returns ask when no ruleSet is provided", () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
    });
    expect(c.checkRules({ tool: "Read", path: "/etc/hosts", cwd: "/tmp" }).decision).toBe("ask");
  });

  it("checkRules honors Read deny rules without UI", () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Read(/etc/**)"]),
    });
    expect(c.checkRules({ tool: "Read", path: "/etc/hosts", cwd: "/tmp" }).decision).toBe("deny");
    expect(c.checkRules({ tool: "Read", path: "/tmp/x.txt", cwd: "/tmp" }).decision).toBe("ask");
  });

  it("deny rule overrides bypassPermissions", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "bypassPermissions",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Bash(rm -rf:*)"]),
    });
    const safe = await c.request({ type: "bash", command: "ls", cwd: "/tmp" });
    expect(safe.action).toBe("approve");

    const dangerous = await c.request({ type: "bash", command: "rm -rf /tmp/x", cwd: "/tmp" });
    expect(dangerous.action).toBe("reject");
    expect(dangerous.feedback).toContain("deny rule");
  });

  it("deny rule overrides dontAsk", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "dontAsk",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Bash(rm -rf:*)"]),
    });
    const dangerous = await c.request({ type: "bash", command: "rm -rf /", cwd: "/tmp" });
    expect(dangerous.action).toBe("reject");
  });

  it("deny rule overrides acceptEdits for writes", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "acceptEdits",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Write(/etc/**)"]),
    });
    const blocked = await c.request({
      type: "write",
      path: "/etc/hosts",
      content: "x",
      fileExists: true,
    });
    expect(blocked.action).toBe("reject");
    expect(blocked.feedback).toContain("Write(/etc/**)");
  });

  it("reads mode lazily so mode changes take effect on the next request", async () => {
    let mode: PermissionMode = "bypassPermissions";
    const c = new PermissionAwareApprovalController({
      getMode: () => mode,
      handlerRef: {},
      cwd: "/tmp/bubble-test",
    });
    expect((await c.request(BASH_REQ)).action).toBe("approve");
    mode = "default";
    expect((await c.request(BASH_REQ)).action).toBe("reject");
  });
});
