import { describe, expect, it } from "vitest";
import { classifyTaskSize } from "../agent/task-size.js";

describe("classifyTaskSize", () => {
  it("flags short Chinese create-a-file requests as small", () => {
    expect(classifyTaskSize("帮我写个html 介绍元旦")).toBe("small");
    expect(classifyTaskSize("写一个 hello world 脚本")).toBe("small");
    expect(classifyTaskSize("新建一个 React 组件")).toBe("small");
  });

  it("flags short English create-file requests as small", () => {
    expect(classifyTaskSize("Write an HTML page about New Year's Day")).toBe("small");
    expect(classifyTaskSize("Create a Python script that prints hello world")).toBe("small");
  });

  it("treats large-scope requests as normal even if they use create verbs", () => {
    expect(classifyTaskSize("refactor the whole project to use TypeScript")).toBe("normal");
    expect(classifyTaskSize("帮我重构整个项目")).toBe("normal");
    expect(classifyTaskSize("write the migration that integrates the whole project")).toBe("normal");
  });

  it("treats vague / discussion-style inputs as normal", () => {
    expect(classifyTaskSize("how does the auth flow work?")).toBe("normal");
    expect(classifyTaskSize("这个项目是干嘛的")).toBe("normal");
  });

  it("ignores empty input", () => {
    expect(classifyTaskSize("")).toBe("normal");
    expect(classifyTaskSize([])).toBe("normal");
  });
});
