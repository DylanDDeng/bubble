import { describe, expect, it } from "vitest";
import { DiscoveryBarrier } from "../agent/discovery-barrier.js";
import type { ParsedToolCall, ToolResult } from "../types.js";

function call(name: string, args: Record<string, unknown>, id = name): ParsedToolCall {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
    parsedArgs: args,
  };
}

describe("DiscoveryBarrier", () => {
  it("blocks repo-orientation reads until a path is discovered", () => {
    const barrier = new DiscoveryBarrier({
      cwd: "/repo",
      input: "看下这个项目在干嘛呢",
      enabled: true,
    });

    const blocked = barrier.beforeToolCall(call("read", { path: "hugo.yaml" }));
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.hiddenFromTranscript).toBe(true);
    expect(blocked?.content).toContain("Do not infer");

    const discoveryResult: ToolResult = {
      content: "README.md\npackage.json",
      status: "success",
      metadata: {
        kind: "search",
        paths: ["/repo/README.md", "/repo/package.json"],
      },
    };
    barrier.afterToolCall(call("glob", { pattern: "*" }), discoveryResult);

    expect(barrier.beforeToolCall(call("read", { path: "README.md" }))).toBeUndefined();
    expect(barrier.beforeToolCall(call("read", { path: "hugo.yaml" }))?.status).toBe("blocked");
  });

  it("allows paths explicitly mentioned by the user", () => {
    const barrier = new DiscoveryBarrier({
      cwd: "/repo",
      input: "帮我看一下 hugo.yaml",
      enabled: true,
    });

    expect(barrier.beforeToolCall(call("read", { path: "hugo.yaml" }))).toBeUndefined();
  });

  it("blocks bash file readers for undiscovered paths", () => {
    const barrier = new DiscoveryBarrier({
      cwd: "/repo",
      input: "看下这个项目在干嘛呢",
      enabled: true,
    });

    const blocked = barrier.beforeToolCall(call("bash", { command: "cat hugo.yaml" }));
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.requestedPath).toBe("hugo.yaml");
  });

  it("runs discovery calls before read calls in the same model batch", () => {
    const barrier = new DiscoveryBarrier({
      cwd: "/repo",
      input: "看下这个项目在干嘛呢",
      enabled: true,
    });
    const calls = [
      call("read", { path: "README.md" }, "read"),
      call("glob", { pattern: "*" }, "glob"),
      call("bash", { command: "rg astro" }, "bash-search"),
    ];

    expect(barrier.orderToolCalls(calls).map((item) => item.id)).toEqual([
      "glob",
      "bash-search",
      "read",
    ]);
  });
});
