import { describe, expect, it } from "vitest";
import { createAllTools } from "../index.js";
import { createToolSearchTool } from "../tool-search.js";
import { GoalStore } from "../../goal/store.js";
import { builtinAgentProfiles, findAgentProfile, selectToolsForAgentProfile } from "../../agent/profiles.js";
import type { LspService } from "../../lsp/index.js";
import type { ToolContext, ToolRegistryEntry } from "../../types.js";

const stubLsp = {} as unknown as LspService;

function allTools(): ToolRegistryEntry[] {
  return createAllTools("/tmp", undefined, {
    lspService: stubLsp,
    goalStore: new GoalStore(),
  });
}

describe("tool surface", () => {
  it("defers exactly the low-frequency tools; the schemas in every turn stay bounded", () => {
    const tools = allTools();
    const deferred = tools.filter((t) => t.deferred).map((t) => t.name).sort();
    expect(deferred).toEqual([
      "close_agent",
      "list_agents",
      "lsp",
      "server_logs",
      "server_status",
      "start_server",
      "stop_server",
    ]);
  });

  it("registers the merged memory tool and update_goal, never the retired names", () => {
    const names = new Set(allTools().map((t) => t.name));
    expect(names.has("memory")).toBe(true);
    expect(names.has("update_goal")).toBe(true);
    expect(names.has("memory_search")).toBe(false);
    expect(names.has("memory_read_summary")).toBe(false);
    expect(names.has("get_goal")).toBe(false);
    expect(names.has("task")).toBe(false);
  });

  it("registers tool_search unconditionally so every host has the deferred unlock path", () => {
    const names = new Set(allTools().map((t) => t.name));
    expect(names.has("tool_search")).toBe(true);
  });

  it("tool_search falls back to the executing agent when no controller is wired", async () => {
    const deferredTool: ToolRegistryEntry = {
      name: "stop_server",
      description: "Stop a managed server",
      parameters: { type: "object", properties: {} },
      deferred: true,
      async execute() {
        return { content: "stopped" };
      },
    };
    const unlocked: string[] = [];
    const ctx = {
      cwd: "/tmp",
      agent: {
        listDeferredTools: () => [deferredTool],
        unlockDeferredTools: (names: string[]) => unlocked.push(...names),
      },
    } as unknown as ToolContext;

    const tool = createToolSearchTool();
    const result = await tool.execute({ query: "select:stop_server" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"name":"stop_server"');
    expect(unlocked).toEqual(["stop_server"]);
  });

  it("explicit profile include pre-unlocks a deferred tool for the child", () => {
    const explorer = findAgentProfile(builtinAgentProfiles(), "explorer")!;
    const selected = selectToolsForAgentProfile(allTools(), explorer);
    const lsp = selected.find((t) => t.name === "lsp");
    // explorer explicitly includes lsp; the child is a fresh Agent with an
    // empty unlock set, so a surviving deferred flag would re-lock it there.
    expect(lsp).toBeDefined();
    expect(lsp!.deferred).toBeFalsy();
  });

  it("legacy memory tool names in user profiles resolve to the merged tool", () => {
    const profile = {
      ...findAgentProfile(builtinAgentProfiles(), "explorer")!,
      tools: { preset: "explicit" as const, include: ["read", "memory_search"], exclude: [] },
    };
    const selected = selectToolsForAgentProfile(allTools(), profile);
    expect(selected.map((t) => t.name)).toContain("memory");
  });
});
