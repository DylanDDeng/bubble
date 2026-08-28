import { describe, expect, it } from "vitest";
import {
  buildTraceGroups,
  executeCommandBlock,
  shouldInlineExecuteCommand,
  traceGroupLabel,
} from "../tui/model/trace-groups.js";
import type { DisplayToolCall } from "../tui/model/display-history.js";

function bashTool(args: Record<string, unknown>, result = "ok"): DisplayToolCall {
  return { id: `bash:${JSON.stringify(args)}`, name: "bash", args, result };
}

describe("execute trace groups", () => {
  it("classifies read-only bash commands by normalized intent before the result arrives", () => {
    const head = buildTraceGroups([bashTool({ command: "head -30 design-qa.md" })])[0];
    expect(head.kind).toBe("read");
    expect(head.title).toBe("Read");
    expect(head.items).toEqual(["design-qa.md"]);

    const compound = buildTraceGroups([
      bashTool({ command: "git diff --stat && head -30 design-qa.md" }),
    ])[0];
    expect(compound.kind).toBe("execute");
  });

  it("honors completed bash read metadata and groups it with native Read calls", () => {
    const groups = buildTraceGroups([
      {
        id: "bash-read",
        name: "bash",
        args: { command: "custom-reader design-qa.md" },
        result: "contents",
        metadata: { kind: "read", path: "design-qa.md" },
      },
      { id: "native-read", name: "read", args: { path: "README.md" }, result: "contents" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("read");
    expect(groups[0].items).toEqual(["design-qa.md", "README.md"]);
  });

  it("captures the model-provided description and preserves command line structure", () => {
    const command = "echo start \\\n  && cp \"$SRC\" \"$DST\"   \n  && ls -la";
    const groups = buildTraceGroups([bashTool({ command, description: "备份配置文件" })]);

    expect(groups[0].description).toBe("备份配置文件");
    expect(groups[0].commandLines).toEqual([
      "echo start \\",
      "  && cp \"$SRC\" \"$DST\"",
      "  && ls -la",
    ]);
    expect(traceGroupLabel(groups[0])).toBe("Execute 备份配置文件");
  });

  it("falls back to the command label when no description is provided", () => {
    const groups = buildTraceGroups([bashTool({ command: "npm test" })]);
    expect(groups[0].description).toBeUndefined();
    expect(traceGroupLabel(groups[0])).toBe("Execute npm test");
  });

  it("inlines only short single-line commands without a description", () => {
    const short = buildTraceGroups([bashTool({ command: "npm test" })])[0];
    expect(shouldInlineExecuteCommand(short, 80)).toBe(true);

    const long = buildTraceGroups([bashTool({ command: `CLASH_CONFIG="${"x".repeat(120)}" && cp a b` })])[0];
    expect(shouldInlineExecuteCommand(long, 80)).toBe(false);

    const multiline = buildTraceGroups([bashTool({ command: "echo a\necho b" })])[0];
    expect(shouldInlineExecuteCommand(multiline, 80)).toBe(false);

    const described = buildTraceGroups([bashTool({ command: "npm test", description: "运行测试" })])[0];
    expect(shouldInlineExecuteCommand(described, 80)).toBe(false);
  });

  it("caps the visible command block and reports omitted lines", () => {
    const command = Array.from({ length: 7 }, (_, i) => `echo line-${i}`).join("\n");
    const group = buildTraceGroups([bashTool({ command })])[0];

    const block = executeCommandBlock(group, 4);
    expect(block.lines).toHaveLength(4);
    expect(block.lines[0]).toBe("echo line-0");
    expect(block.omitted).toBe(3);
  });

  it("projects background Execute calls through started and terminal lifecycle labels", () => {
    const started = buildTraceGroups([{
      id: "call-bg",
      name: "bash",
      args: { command: "npm test", description: "Run tests" },
      status: "completed",
      startedAt: 1_000,
      metadata: { kind: "shell", background: true, taskId: "task_0001" },
    }])[0]!;
    expect(started.title).toBe("Task started");
    expect(started.statusLabel).toBe("task_0001");

    const completed = buildTraceGroups([{
      id: "task-lifecycle:task_0001:3000",
      name: "bash",
      args: { command: "npm test", description: "Run tests" },
      status: "completed",
      startedAt: 1_000,
      metadata: {
        kind: "shell",
        background: true,
        taskId: "task_0001",
        taskLifecycle: "completed",
        endedAt: 3_000,
        exitCode: 0,
        outputLines: 12,
      },
    }])[0]!;
    expect(completed.title).toBe("Task completed");
    expect(completed.statusLabel).toBe("task_0001 · in 2s · exit 0 · 12 lines");
  });
});
