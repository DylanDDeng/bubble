import { describe, expect, it, vi } from "vitest";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { PermissionMode } from "../types.js";

function makeController(mode: PermissionMode, handler?: (req: ApprovalRequest) => Promise<ApprovalDecision>) {
  const handlerRef: { current?: (req: ApprovalRequest) => Promise<ApprovalDecision> } = {};
  if (handler) handlerRef.current = handler;
  return new PermissionAwareApprovalController({
    getMode: () => mode,
    handlerRef,
  });
}

const EDIT_REQ: ApprovalRequest = { type: "edit", path: "/tmp/f.ts", diff: "diff", fileExists: true };
const WRITE_REQ: ApprovalRequest = { type: "write", path: "/tmp/new.ts", content: "hi", fileExists: false };
const BASH_REQ: ApprovalRequest = { type: "bash", command: "ls", cwd: "/tmp" };

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

  it("reads mode lazily so mode changes take effect on the next request", async () => {
    let mode: PermissionMode = "bypassPermissions";
    const c = new PermissionAwareApprovalController({
      getMode: () => mode,
      handlerRef: {},
    });
    expect((await c.request(BASH_REQ)).action).toBe("approve");
    mode = "default";
    expect((await c.request(BASH_REQ)).action).toBe("reject");
  });
});
