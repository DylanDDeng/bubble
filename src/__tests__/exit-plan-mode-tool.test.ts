import { describe, expect, it } from "vitest";
import { createExitPlanModeTool } from "../tools/exit-plan-mode.js";
import type { PermissionMode, PlanDecision } from "../types.js";

function createController(
  respond: (plan: string) => Promise<PlanDecision>,
  initialMode: PermissionMode = "plan",
) {
  const setModeCalls: PermissionMode[] = [];
  let mode: PermissionMode = initialMode;
  return {
    controller: {
      getMode: () => mode,
      requestApproval: respond,
      setMode: (next: PermissionMode) => {
        setModeCalls.push(next);
        mode = next;
      },
    },
    setModeCalls,
    getMode: () => mode,
  };
}

describe("exit_plan_mode tool", () => {
  it("is read-only so it is allowed during plan mode", () => {
    const { controller } = createController(async () => ({ action: "reject" }));
    const tool = createExitPlanModeTool(controller);
    expect(tool.readOnly).toBe(true);
  });

  it("returns an error without prompting the user when called outside plan mode", async () => {
    const { controller, setModeCalls } = createController(
      async () => ({ action: "approve", plan: "p" }),
      "default",
    );
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "some plan" }, { cwd: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only valid while plan mode is active");
    expect(setModeCalls).toEqual([]); // did not flip
  });

  it("rejects empty plan arg", async () => {
    const { controller } = createController(async () => ({ action: "approve", plan: "x" }));
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "   " }, { cwd: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan is required");
  });

  it("on approval: flips mode to default and reports the approved plan", async () => {
    const { controller, setModeCalls } = createController(async (plan) => ({
      action: "approve",
      plan,
    }));
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "Step 1\nStep 2" }, { cwd: "/tmp" });
    expect(result.isError).toBeFalsy();
    expect(setModeCalls).toEqual(["default"]);
    expect(result.content).toContain("approved");
    expect(result.content).toContain("Step 1");
    expect(result.content).toContain("default");
    expect(result.content).not.toContain("(with edits)");
  });

  it("marks approval as edited when the returned plan differs", async () => {
    const { controller } = createController(async () => ({
      action: "approve",
      plan: "Edited step 1",
    }));
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "Original step 1" }, { cwd: "/tmp" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("(with edits)");
    expect(result.content).toContain("Edited step 1");
  });

  it("on rejection: does NOT flip mode and tells the model to keep planning", async () => {
    const { controller, setModeCalls } = createController(async () => ({
      action: "reject",
      reason: "too risky",
    }));
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "something" }, { cwd: "/tmp" });
    expect(result.isError).toBeFalsy();
    expect(setModeCalls).toEqual([]);
    expect(result.content).toContain("rejected");
    expect(result.content).toContain("too risky");
  });

  it("wraps controller errors as tool errors", async () => {
    const { controller } = createController(async () => {
      throw new Error("boom");
    });
    const tool = createExitPlanModeTool(controller);
    const result = await tool.execute({ plan: "anything" }, { cwd: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });
});
