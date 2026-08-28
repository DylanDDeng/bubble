import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessManager } from "../tasks/manager.js";
import { PromotionChannel } from "../tasks/promotion.js";
import { createBashTool } from "../tools/bash.js";

const cwd = join(tmpdir(), `bubble-task-promotion-${process.pid}`);
mkdirSync(cwd, { recursive: true });

function backgroundBash(manager: ProcessManager, channel: PromotionChannel) {
  return createBashTool(cwd, undefined, undefined, {
    processManager: manager,
    allowBackgroundTasks: true,
    promotionChannel: channel,
  });
}

describe("Ctrl+B and automatic promotion", () => {
  it("promotes a running foreground command: tool resolves, process keeps running, output lands in the task", async () => {
    const manager = new ProcessManager();
    const channel = new PromotionChannel();
    const bash = backgroundBash(manager, channel);

    const resultPromise = bash.execute(
      { command: "echo before-promotion; sleep 1; echo after-promotion; exit 0" },
      { cwd, sessionID: "s1", toolCall: { id: "call_1", name: "bash" } } as any,
    );

    // Give the command a moment to emit its first line, then promote.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(channel.hasPromotable("call_1")).toBe(true);
    const taskId = channel.requestPromotion("call_1");
    expect(taskId).toMatch(/^task_\d{4}$/);

    const result = await resultPromise;
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`Moved to background: ${taskId}`);
    expect(result.content).toContain("before-promotion");

    // The process was NOT killed by the tool resolution: it finishes under
    // the manager and its post-promotion output is captured.
    const [done] = await manager.waitTasks([taskId!], { timeoutMs: 8000 });
    expect(done!.status).toBe("completed");
    expect(manager.taskOutputTail(taskId!)).toContain("after-promotion");
  });

  it("is a no-op after the command already finished (race guard)", async () => {
    const manager = new ProcessManager();
    const channel = new PromotionChannel();
    const bash = backgroundBash(manager, channel);

    const result = await bash.execute(
      { command: "echo done" },
      { cwd, sessionID: "s1", toolCall: { id: "call_2", name: "bash" } } as any,
    );
    expect(result.isError).toBeFalsy();

    // The handler unregisters on finish; a late Ctrl+B finds nothing.
    expect(channel.hasPromotable("call_2")).toBe(false);
    expect(channel.requestPromotion("call_2")).toBeUndefined();
  });

  it("does not register a promotion handler when the host capability is off", async () => {
    const channel = new PromotionChannel();
    const bash = createBashTool(cwd);

    const resultPromise = bash.execute(
      { command: "sleep 0.3" },
      { cwd, toolCall: { id: "call_3", name: "bash" } } as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(channel.hasPromotable("call_3")).toBe(false);
    await resultPromise;
  });

  it("automatically demotes a command after the configured foreground budget", async () => {
    const manager = new ProcessManager();
    const channel = new PromotionChannel();
    const bash = createBashTool(cwd, undefined, undefined, {
      processManager: manager,
      allowBackgroundTasks: true,
      promotionChannel: channel,
      autoBackgroundAfterMs: 50,
    });

    const result = await bash.execute(
      { command: "echo before-auto; sleep 0.3; echo after-auto" },
      { cwd, sessionID: "s1", toolCall: { id: "call_auto", name: "bash" } } as any,
    );
    const taskId = String(result.metadata?.taskId);
    expect(result.content).toContain(`Moved to background: ${taskId}`);
    expect(taskId).toMatch(/^task_\d{4}$/);

    const [done] = await manager.waitTasks([taskId], { timeoutMs: 5000 });
    expect(done?.status).toBe("completed");
    expect(manager.taskOutputTail(taskId)).toContain("after-auto");
  });
});
