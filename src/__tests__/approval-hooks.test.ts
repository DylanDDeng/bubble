import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import type { ApprovalDecision } from "../approval/types.js";
import { ExternalHookController } from "../hooks/index.js";

function hookController(source: string) {
  const root = mkdtempSync(join(tmpdir(), "bubble-approval-hooks-"));
  const bubbleHome = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(bubbleHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(bubbleHome, "settings.json"), JSON.stringify({
    hooks: {
      rules: [{
        id: "permission-hook",
        event: "PermissionRequest",
        matcher: "^Bash$",
        command: process.execPath,
        args: ["-e", source],
      }],
    },
  }, null, 2), "utf-8");
  return { cwd, hooks: new ExternalHookController({ cwd, bubbleHome }) };
}

describe("approval lifecycle hooks", () => {
  it("can reject a permission request before the UI handler is shown", async () => {
    const handler = vi.fn(async () => ({ action: "approve" }) as ApprovalDecision);
    const { cwd, hooks } = hookController(
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'blocked by permission hook'})))",
    );
    const controller = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: handler },
      cwd,
      externalHooks: hooks,
    });

    const result = await controller.request({ type: "bash", command: "git status", cwd });

    expect(result).toEqual({ action: "reject", feedback: "blocked by permission hook" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("cannot turn a later UI rejection into approval", async () => {
    const { cwd, hooks } = hookController(
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'allow'})))",
    );
    const controller = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: { current: async () => ({ action: "reject", feedback: "user said no" }) },
      cwd,
      externalHooks: hooks,
    });

    const result = await controller.request({ type: "bash", command: "git status", cwd });

    expect(result).toEqual({ action: "reject", feedback: "user said no" });
  });
});
