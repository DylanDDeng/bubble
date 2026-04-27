import { describe, expect, it } from "vitest";
import { sourceRank, asUnified, type UnifiedCommand } from "../slash-commands/unified.js";
import { SlashCommandRegistry } from "../slash-commands/registry.js";

describe("sourceRank", () => {
  it("orders builtin before skill before mcp", () => {
    expect(sourceRank("builtin")).toBeLessThan(sourceRank("skill"));
    expect(sourceRank("skill")).toBeLessThan(sourceRank("mcp"));
  });

  it("treats undefined as builtin (for legacy SlashCandidate without source)", () => {
    expect(sourceRank(undefined)).toBe(sourceRank("builtin"));
  });

  it("sorts commands stably by source then name", () => {
    const commands: UnifiedCommand[] = [
      asUnified({ name: "zulu-help", description: "", handler: async () => "" }, "builtin"),
      { name: "bravo", description: "", source: "mcp", sourceLabel: "exa", handler: async () => "" },
      { name: "alpha", description: "", source: "mcp", sourceLabel: "tavily", handler: async () => "" },
      asUnified({ name: "apple", description: "", handler: async () => "" }, "builtin"),
    ];

    const sorted = [...commands].sort(
      (a, b) => sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name),
    );

    expect(sorted.map((c) => c.name)).toEqual(["apple", "zulu-help", "alpha", "bravo"]);
  });
});

describe("SlashCommandRegistry source tagging", () => {
  it("defaults built-in commands registered via register() to source: builtin", () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: "doit",
      description: "",
      async handler() {
        return "";
      },
    });
    expect(reg.list()[0].source).toBe("builtin");
  });

  it("preserves explicit source from dynamic sources (MCP-style)", () => {
    const reg = new SlashCommandRegistry();
    reg.addDynamicSource(() => [
      {
        name: "research",
        description: "",
        source: "mcp",
        sourceLabel: "exa",
        async handler() {
          return { inject: "go" };
        },
      } as UnifiedCommand,
    ]);

    const items = reg.list();
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("mcp");
    expect(items[0].sourceLabel).toBe("exa");
  });

  it("listBySource filters correctly", () => {
    const reg = new SlashCommandRegistry();
    reg.register({ name: "help", description: "", async handler() { return ""; } });
    reg.addDynamicSource(() => [
      { name: "search", description: "", source: "mcp", sourceLabel: "exa", async handler() { return ""; } } as UnifiedCommand,
    ]);

    expect(reg.listBySource("builtin").map((c) => c.name)).toEqual(["help"]);
    expect(reg.listBySource("mcp").map((c) => c.name)).toEqual(["search"]);
  });
});
