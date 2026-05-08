import { describe, expect, it } from "vitest";
import { classifyTask } from "../agent/task-classifier.js";
import { reminderForTaskType } from "../prompt/task-reminders.js";

describe("task classifier reminders", () => {
  it("classifies common task types and exposes focused reminders", () => {
    expect(classifyTask("debug this failing provider request")).toBe("debugging");
    expect(classifyTask("implement provider-specific prompts")).toBe("implementation");
    expect(classifyTask("review this diff for bugs")).toBe("code_review");
    expect(classifyTask("这个项目在干嘛")).toBe("repo_orientation");

    expect(reminderForTaskType("debugging")).toContain("Debugging workflow");
    expect(reminderForTaskType("implementation")).toContain("Implementation workflow");
    expect(reminderForTaskType("general")).toBeUndefined();
  });
});
