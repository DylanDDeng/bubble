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
});
