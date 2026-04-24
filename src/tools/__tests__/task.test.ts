import { describe, expect, it } from "vitest";
import { createTaskTool } from "../task.js";

describe("task tool", () => {
  it("delegates to the agent runtime subtask runner", async () => {
    const tool = createTaskTool();
    const result = await tool.execute(
      {
        prompt: "Find where the token is loaded",
        description: "Investigate token loading",
        subtaskType: "security_investigation",
      },
      {
        cwd: "/tmp",
        agent: {
          runSubtask: async (input, _cwd, options) => ({
            content: `subtask:${typeof input === "string" ? input : "complex"}:${options?.subtaskType}`,
            status: "success",
          }),
        },
      },
    );

    expect(result.content).toContain(":security_investigation");
    expect(result.status).toBe("success");
  });

  it("fails cleanly when no agent runtime is available", async () => {
    const tool = createTaskTool();
    const result = await tool.execute({ prompt: "Check config" }, { cwd: "/tmp" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("agent runtime");
  });
});
