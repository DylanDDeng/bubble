import { describe, expect, it } from "vitest";
import { classifyTask } from "../agent/task-classifier.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";

describe("task classifier reminders", () => {
  it("classifies common task types and exposes focused reminders", () => {
    expect(classifyTask("debug this failing provider request")).toBe("debugging");
    expect(classifyTask("implement provider-specific prompts")).toBe("implementation");
    expect(classifyTask("review this diff for bugs")).toBe("code_review");
    expect(classifyTask("这个项目在干嘛")).toBe("repo_orientation");
    expect(classifyTask("看下这项目在干嘛呢")).toBe("repo_orientation");
    expect(classifyTask("这个 repo 是干嘛的")).toBe("repo_orientation");
    expect(classifyTask("看下这个项目中，文件预览是否支持 MDX")).not.toBe("repo_orientation");
    expect(classifyTask("看下这个项目，帮我实现 MDX 支持")).toBe("implementation");

    expect(reminderForTaskType("debugging")).toContain("Debugging workflow");
    expect(reminderForTaskType("implementation")).toContain("Implementation workflow");
    expect(reminderForTaskType("general")).toBeUndefined();
  });
});
