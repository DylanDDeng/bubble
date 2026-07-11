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
const PATCH_REQ: ApprovalRequest = {
  type: "patch",
  path: "/tmp/bubble-test/src/a.ts (+1 more)",
  paths: ["/tmp/bubble-test/src/a.ts", "/tmp/bubble-test/generated/new.ts"],
  files: [
    { path: "/tmp/bubble-test/src/a.ts", kind: "update" },
    { path: "/tmp/bubble-test/generated/new.ts", kind: "add" },
  ],
  diff: "diff",
};
const BASH_REQ: ApprovalRequest = { type: "bash", command: "ls", cwd: "/tmp" };
const LSP_REQ: ApprovalRequest = { type: "lsp", path: "/tmp/bubble-test/src/a.ts", operation: "hover" };
const EXTERNAL_REQ: ApprovalRequest = {
  type: "external_tool",
  toolCallId: "grok-tool-1",
  title: "Run command",
  kind: "execute",
  rawInput: { command: "git status" },
};

describe("PermissionAwareApprovalController", () => {
  it("auto-approves every request in bypassPermissions", async () => {
    const c = makeController("bypassPermissions");
    expect(await c.request(EDIT_REQ)).toEqual({ action: "approve" });
    expect(await c.request(WRITE_REQ)).toEqual({ action: "approve" });
    expect(await c.request(PATCH_REQ)).toEqual({ action: "approve" });
    expect(await c.request(BASH_REQ)).toEqual({ action: "approve" });
  });

  it("auto-approves edit/write/patch in default Build mode but still asks for bash", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const handlerRef = { current: handler };
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef,
      cwd: "/tmp/bubble-test",
    });

    expect(await c.request(EDIT_REQ)).toEqual({ action: "approve" });
    expect(await c.request(WRITE_REQ)).toEqual({ action: "approve" });
    expect(await c.request(PATCH_REQ)).toEqual({ action: "approve" });
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

  it("delegates bash to the UI handler in default mode", async () => {
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

  it("asks for external tools in default mode when no explicit rule allows them", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = makeController("default", handler);

    expect(await c.request(EXTERNAL_REQ)).toEqual({ action: "approve" });
    expect(handler).toHaveBeenCalledWith(EXTERNAL_REQ);
  });

  it("maps structured external execute and edit requests onto native rules", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet(
        ["Bash(git status)"],
        ["Edit(./secrets/**)"],
      ),
    });

    expect((await c.request(EXTERNAL_REQ)).action).toBe("approve");
    expect(handler).not.toHaveBeenCalled();

    const blocked = await c.request({
      type: "external_tool",
      toolCallId: "grok-tool-2",
      title: "Delete file",
      kind: "delete",
      locations: [{ path: "/tmp/bubble-test/secrets/token.txt" }],
    });
    expect(blocked.action).toBe("reject");
    expect(blocked.feedback).toContain("Edit(./secrets/**)");
    expect(handler).not.toHaveBeenCalled();
  });

  it("falls back to the external title, then kind, for tool-level rules", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {},
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet(["SearchFiles"], ["fetch"]),
    });

    expect((await c.request({
      type: "external_tool",
      toolCallId: "search-1",
      title: "SearchFiles",
      kind: "search",
    })).action).toBe("approve");
    expect((await c.request({
      type: "external_tool",
      toolCallId: "fetch-1",
      title: " ",
      kind: "fetch",
    })).action).toBe("reject");
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

  it("deny rule overrides default Build auto-approval for writes", async () => {
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
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

  it("deny rule checks every patch file using Edit/Write semantics", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const c = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd: "/tmp/bubble-test",
      getRuleSet: () => buildRuleSet([], ["Write(./generated/**)"]),
    });
    const blocked = await c.request(PATCH_REQ);
    expect(blocked.action).toBe("reject");
    expect(blocked.feedback).toContain("Write(./generated/**)");
    expect(handler).not.toHaveBeenCalled();
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
