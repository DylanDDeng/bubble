import { describe, expect, it } from "vitest";
import { sidebarMcpRowsFromStates, renderMcpRowMarker } from "../tui/sidebar-mcp.js";
import type { McpServerState } from "../mcp/types.js";

describe("sidebarMcpRowsFromStates", () => {
  it("connected rows show tool count and prompt count when present", () => {
    const rows = sidebarMcpRowsFromStates([
      {
        name: "exa",
        scope: "user",
        config: { type: "http", url: "https://x" },
        status: {
          kind: "connected",
          tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
          prompts: [{ name: "p" }],
        },
      },
    ]);
    expect(rows[0].label).toBe("3 tools, 1 prompt");
    expect(rows[0].canReconnect).toBe(false);
    expect(rows[0].toolCount).toBe(3);
    expect(rows[0].promptCount).toBe(1);
  });

  it("connected rows omit prompt count when zero", () => {
    const rows = sidebarMcpRowsFromStates([
      {
        name: "fs",
        scope: "user",
        config: { type: "stdio", command: "echo" },
        status: { kind: "connected", tools: [{ name: "x" }], prompts: [] },
      },
    ]);
    expect(rows[0].label).toBe("1 tool");
  });

  it("failed rows surface truncated error and allow reconnect", () => {
    const longError = "connection refused " + "x".repeat(100);
    const rows = sidebarMcpRowsFromStates([
      {
        name: "acme",
        scope: "user",
        config: { type: "http", url: "https://x" },
        status: { kind: "failed", error: longError },
      },
    ]);
    expect(rows[0].label.length).toBeLessThanOrEqual(32);
    expect(rows[0].canReconnect).toBe(true);
    expect(rows[0].errorDetail).toBe(longError);
  });

  it("disabled rows label themselves disabled and allow reconnect", () => {
    const rows = sidebarMcpRowsFromStates([
      {
        name: "off",
        scope: "user",
        config: { type: "stdio", command: "echo" },
        status: { kind: "disabled" },
      },
    ]);
    expect(rows[0].label).toBe("disabled");
    expect(rows[0].canReconnect).toBe(true);
  });
});

describe("renderMcpRowMarker", () => {
  it("maps each status kind to the expected glyph", () => {
    expect(renderMcpRowMarker("connected")).toBe("●");
    expect(renderMcpRowMarker("failed")).toBe("✗");
    expect(renderMcpRowMarker("disabled")).toBe("○");
  });
});
