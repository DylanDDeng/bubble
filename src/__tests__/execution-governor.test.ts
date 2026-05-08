import { describe, expect, it } from "vitest";
import { ExecutionGovernor } from "../agent/execution-governor.js";
import type { ParsedToolCall, ToolResult } from "../types.js";

function grepCall(pattern: string, path = "."): ParsedToolCall {
  return {
    id: `${pattern}:${path}`,
    name: "grep",
    arguments: JSON.stringify({ pattern, path }),
    parsedArgs: { pattern, path },
  };
}

function readCall(path: string, offset?: number, limit?: number): ParsedToolCall {
  return {
    id: `${path}:${offset ?? ""}:${limit ?? ""}`,
    name: "read",
    arguments: JSON.stringify({ path, offset, limit }),
    parsedArgs: { path, offset, limit },
  };
}

function bashCall(command: string): ParsedToolCall {
  return {
    id: command,
    name: "bash",
    arguments: JSON.stringify({ command }),
    parsedArgs: { command },
  };
}

function noMatchResult(pattern: string, path = "."): ToolResult {
  return {
    content: "No matches found.",
    status: "no_match",
    metadata: {
      kind: "search",
      pattern,
      path,
      matches: 0,
      searchSignature: `${path}::*::secret`,
      searchFamily: `${path}::secret`,
    },
  };
}

function readResult(path: string): ToolResult {
  return {
    content: "<html>\n<body>test</body>\n</html>",
    status: "success",
    metadata: {
      kind: "read",
      path,
    },
  };
}

describe("ExecutionGovernor", () => {
  it("starts security investigations with a workflow reminder", () => {
    const governor = new ExecutionGovernor("security_investigation");
    expect(governor.consumePendingReminders()[0]).toContain("Security/configuration investigation workflow is active");
  });

  it("blocks repeated no-progress search families", () => {
    const governor = new ExecutionGovernor("security_investigation");
    governor.consumePendingReminders();

    const first = grepCall("API_KEY", "src");
    expect(governor.beforeToolCall(first).blockedResult).toBeUndefined();
    governor.afterToolResult(first, noMatchResult("API_KEY", "src"));

    const second = grepCall("apiKey", "src");
    expect(governor.beforeToolCall(second).blockedResult).toBeUndefined();
    governor.afterToolResult(second, noMatchResult("apiKey", "src"));

    const third = grepCall("secret", "src");
    expect(governor.beforeToolCall(third).blockedResult).toBeUndefined();
    governor.afterToolResult(third, noMatchResult("secret", "src"));

    const fourth = grepCall("token", "src");
    const decision = governor.beforeToolCall(fourth);
    expect(decision.blockedResult?.status).toBe("blocked");
    expect(governor.consumePendingReminders().some((item) => item.includes("Search tools are now constrained"))).toBe(true);
  });

  it("moves implementation tasks from repeated reads into modify phase", () => {
    const governor = new ExecutionGovernor("implementation");

    const first = readCall("three-kingdoms-td.html", 1, 100);
    expect(governor.beforeToolCall(first).blockedResult).toBeUndefined();
    governor.afterToolResult(first, readResult("three-kingdoms-td.html"));

    const second = readCall("three-kingdoms-td.html", 1, 100);
    const decision = governor.beforeToolCall(second);
    expect(decision.blockedResult?.status).toBe("blocked");
    expect(decision.blockedResult?.metadata?.kind).toBe("read");
    expect(governor.snapshot().phase).toBe("modify");
    expect(governor.snapshot().explorationFrozen).toBe(true);
    expect(governor.consumePendingReminders().some((item) => item.includes("advanced from exploration to modification"))).toBe(true);
  });

  it("filters exploration tools during modify phase but keeps edit and verification tools", () => {
    const governor = new ExecutionGovernor("implementation");
    const first = readCall("index.html", 1, 100);
    governor.beforeToolCall(first);
    governor.afterToolResult(first, readResult("index.html"));
    governor.beforeToolCall(readCall("index.html", 1, 100));

    const filtered = governor.filterToolDefinitions([
      tool("read"),
      tool("glob"),
      tool("grep"),
      tool("web_search"),
      tool("tool_search"),
      tool("edit"),
      tool("write"),
      tool("bash"),
      tool("lsp"),
    ]).map((entry) => entry.name);

    expect(filtered).toEqual(["edit", "write", "bash", "lsp"]);
  });

  it("treats bash file readers as exploration during modify phase", () => {
    const governor = new ExecutionGovernor("implementation");
    const first = bashCall("sed -n '1,100p' index.html");
    expect(governor.beforeToolCall(first).blockedResult).toBeUndefined();
    governor.afterToolResult(first, readResult("index.html"));

    const second = bashCall("sed -n '1,100p' index.html");
    expect(governor.beforeToolCall(second).blockedResult?.status).toBe("blocked");
  });
});

function tool(name: string) {
  return {
    name,
    description: "",
    parameters: { type: "object" as const, properties: {} },
    execute: async () => ({ content: "" }),
  };
}
