import { describe, expect, it } from "vitest";
import {
  buildMcpToolName,
  getMcpPrefix,
  mcpInfoFromString,
  normalizeNameForMCP,
} from "../mcp/name.js";

describe("normalizeNameForMCP", () => {
  it("preserves allowed characters", () => {
    expect(normalizeNameForMCP("github-search_v2")).toBe("github-search_v2");
  });

  it("replaces invalid characters with underscore", () => {
    expect(normalizeNameForMCP("my.server name")).toBe("my_server_name");
    expect(normalizeNameForMCP("acme/corp:thing")).toBe("acme_corp_thing");
  });
});

describe("getMcpPrefix / buildMcpToolName", () => {
  it("builds the mcp__server__tool form", () => {
    expect(getMcpPrefix("github")).toBe("mcp__github__");
    expect(buildMcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  it("normalizes server and tool independently", () => {
    expect(buildMcpToolName("acme.co", "do thing")).toBe("mcp__acme_co__do_thing");
  });
});

describe("mcpInfoFromString", () => {
  it("parses canonical form", () => {
    expect(mcpInfoFromString("mcp__github__create_issue")).toEqual({
      serverName: "github",
      toolName: "create_issue",
    });
  });

  it("keeps double underscores in the tool name", () => {
    expect(mcpInfoFromString("mcp__srv__a__b")).toEqual({
      serverName: "srv",
      toolName: "a__b",
    });
  });

  it("returns null for non-mcp names", () => {
    expect(mcpInfoFromString("Bash")).toBeNull();
    expect(mcpInfoFromString("mcp__")).toBeNull();
    expect(mcpInfoFromString("mcp__srv")).toBeNull();
  });
});
