import { describe, expect, it } from "vitest";
import { buildTraceGroups, traceGroupLabel } from "../tui/trace-groups.js";
import type { DisplayToolCall } from "../tui/display-history.js";

function mcpTool(
  name: string,
  args: Record<string, unknown>,
  result = "ok",
): DisplayToolCall {
  return { id: `${name}:${JSON.stringify(args)}`, name, args, result };
}

describe("MCP trace groups", () => {
  it("renders the server name uppercased with the bare tool name as title", () => {
    const group = buildTraceGroups([mcpTool("mcp__paper__get_basic_info", {})])[0];
    expect(group.kind).toBe("other");
    expect(group.title).toBe("PAPER: get_basic_info");
    // No "1 call" fallback when there are no args.
    expect(group.count).toBeUndefined();
    expect(group.noun).toBeUndefined();
    expect(traceGroupLabel(group)).toBe("PAPER: get_basic_info");
  });

  it("renders arguments inline as key: value pairs (numbers bare, strings quoted)", () => {
    const group = buildTraceGroups([
      mcpTool("mcp__paper__get_tree_summary", { depth: 3, nodeId: "1-0" }),
    ])[0];
    expect(group.title).toBe("PAPER: get_tree_summary");
    expect(group.command).toBe('depth: 3, nodeId: "1-0"');
    expect(traceGroupLabel(group)).toBe('PAPER: get_tree_summary depth: 3, nodeId: "1-0"');
  });

  it("leaves non-MCP unknown tools on the legacy title formatting", () => {
    const group = buildTraceGroups([mcpTool("custom_thing", { a: 1 })])[0];
    expect(group.title).toBe("Custom thing");
    expect(group.command).toBeUndefined();
  });
});
