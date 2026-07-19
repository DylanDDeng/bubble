import { describe, expect, it } from "vitest";
import { INK_LOCAL_SLASH_COMMANDS, isInternalBlockOnlyContent, reconstructDisplayMessages } from "../tui-ink/app.js";
import type { Message } from "../types.js";
import { createInkAppElement } from "../tui-ink/run.js";
import { GoalStore } from "../goal/store.js";

describe("Ink goal command integration", () => {
  it("exposes /goal as a local Ink slash command", () => {
    expect(INK_LOCAL_SLASH_COMMANDS).toContainEqual({
      name: "goal",
      description: "Set/manage an autonomous goal (/goal <objective>|clear|pause|resume|edit)",
    });
  });

  it("exposes local display commands in the Ink slash palette", () => {
    expect(INK_LOCAL_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "goal",
      "loop",
    ]);
  });

  it("passes the shared goal store from the Ink runner into the App", () => {
    const goalStore = new GoalStore();
    const element = createInkAppElement(
      {} as any,
      { cwd: "/tmp/project" } as any,
      { goalStore },
      () => {},
    );

    expect((element.props as any).goalStore).toBe(goalStore);
  });
});

describe("harness-injected kick reconstruction", () => {
  it("hides internal-block-only user messages (goal kicks, task wakes) on resume", () => {
    const messages: Message[] = [
      { role: "user", content: "帮我在后台跑一下全量测试" },
      { role: "assistant", content: "任务已启动。" },
      {
        role: "user",
        content: "<bubble_internal_context kind=\"task-finished\">\nA background task you started has finished.\n</bubble_internal_context>",
      },
      { role: "assistant", content: "全量测试已通过。" },
    ] as Message[];

    const display = reconstructDisplayMessages(messages);
    const userRows = display.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toContain("全量测试");
    expect(display.some((m) => m.content?.includes?.("bubble_internal_context"))).toBe(false);
  });

  it("keeps user messages that merely mention internal blocks", () => {
    expect(isInternalBlockOnlyContent("请解释 <bubble_internal_context> 是什么")).toBe(false);
    expect(isInternalBlockOnlyContent(
      "<bubble_internal_context kind=\"goal\">\ncontinue\n</bubble_internal_context>",
    )).toBe(true);
    expect(isInternalBlockOnlyContent("普通消息")).toBe(false);
  });
});
