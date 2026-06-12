import { describe, expect, it } from "vitest";
import {
  buildTraceGroups,
  executeCommandBlock,
  shouldInlineExecuteCommand,
  traceGroupLabel,
} from "../tui/trace-groups.js";
import type { DisplayToolCall } from "../tui/display-history.js";

function bashTool(args: Record<string, unknown>, result = "ok"): DisplayToolCall {
  return { id: `bash:${JSON.stringify(args)}`, name: "bash", args, result };
}

describe("execute trace groups", () => {
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
});
