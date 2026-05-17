import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { assignAgentNickname, discoverAgentProfiles, findAgentProfile, selectToolsForAgentProfile, validateAgentProfileTools } from "../agent/profiles.js";
import type { ToolRegistryEntry } from "../types.js";

const previousHome = process.env.BUBBLE_HOME;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.BUBBLE_HOME;
  } else {
    process.env.BUBBLE_HOME = previousHome;
  }
});

function tool(name: string, effect: ToolRegistryEntry["effect"], extra: Partial<ToolRegistryEntry> = {}): ToolRegistryEntry {
  return {
    name,
    effect,
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
    ...extra,
  };
}

describe("agent profiles", () => {
  it("discovers user profiles and parses frontmatter tools", () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-home-"));
    process.env.BUBBLE_HOME = home;
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "scout.md"), [
      "---",
      "name: scout",
      "description: Scout files",
      "mode: readonly",
      "tools:",
      "  preset: explicit",
      "  include:",
      "    - read",
      "    - grep",
      "    - edit",
      "    - subagent",
      "  exclude:",
      "    - grep",
      "maxTurns: 3",
      "approval: fail",
      "nicknameCandidates:",
      "  - Scout",
      "  - Surveyor",
      "---",
      "Scout prompt",
    ].join("\n"));

    const result = discoverAgentProfiles("/tmp", "user");
    const profile = findAgentProfile(result.profiles, "scout");

    expect(profile?.prompt).toBe("Scout prompt");
    expect(profile?.tools.preset).toBe("explicit");
    expect(profile?.tools.include).toEqual(["read", "grep", "edit", "subagent"]);
    expect(profile?.tools.exclude).toEqual(["grep"]);
    expect(profile?.maxTurns).toBe(3);
    expect(profile?.nicknameCandidates).toEqual(["Scout", "Surveyor"]);
  });

  it("provides Codex-style builtin roles and assigns nicknames separate from profile names", () => {
    const profiles = discoverAgentProfiles("/tmp", "user").profiles;
    expect(findAgentProfile(profiles, "default")?.source).toBe("builtin");
    expect(findAgentProfile(profiles, "explorer")?.source).toBe("builtin");
    expect(findAgentProfile(profiles, "worker")?.source).toBe("builtin");

    const profile = findAgentProfile(profiles, "default")!;
    const nickname = assignAgentNickname(profile, [profile.name]);

    expect(nickname).toBeTruthy();
    expect(nickname).not.toBe(profile.name);
  });

  it("does not impose hard turn limits on builtin lifecycle subagents", () => {
    const profiles = discoverAgentProfiles("/tmp", "user").profiles.filter((profile) => profile.source === "builtin");

    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.every((profile) => profile.maxTurns === undefined)).toBe(true);
  });

  it("filters tools by profile, effect, approval, and recursive subagent denylist", () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "builtin:general_readonly")!;
    const selected = selectToolsForAgentProfile([
      tool("read", "read"),
      tool("grep", "read"),
      tool("lsp", "read", { requiresApproval: true }),
      tool("edit", "write_direct"),
      tool("mcp_tool", "unknown"),
      tool("subagent", "read"),
      tool("task", "read"),
    ], profile, "disabled");

    expect(selected.map((item) => item.name)).toEqual(["read", "grep"]);
  });

  it("wraps approval-requiring tools with fail-fast blocked results", async () => {
    const profile = {
      name: "approval-test",
      description: "Approval test",
      source: "user" as const,
      mode: "readonly" as const,
      tools: {
        preset: "explicit" as const,
        include: ["lsp"],
      },
      approval: "fail" as const,
      prompt: "Inspect.",
    };
    const selected = selectToolsForAgentProfile([
      tool("lsp", "read", { requiresApproval: true }),
    ], profile, "fail");

    const result = await selected[0].execute({}, { cwd: "/tmp" });

    expect(result.status).toBe("blocked");
    expect(result.content).toContain("requires interactive approval");
  });

  it("ignores project profiles unless project scope is requested", () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-home-"));
    const project = mkdtempSync(join(tmpdir(), "bubble-project-"));
    process.env.BUBBLE_HOME = home;
    mkdirSync(join(project, ".bubble", "agents"), { recursive: true });
    writeFileSync(join(project, ".bubble", "agents", "repo-scout.md"), [
      "---",
      "name: repo-scout",
      "description: Repo scout",
      "tools: readonly",
      "---",
      "Inspect project files.",
    ].join("\n"));

    expect(findAgentProfile(discoverAgentProfiles(project, "user").profiles, "repo-scout")).toBeUndefined();
    expect(findAgentProfile(discoverAgentProfiles(project, "project").profiles, "repo-scout")?.source).toBe("project");
  });

  it("parses top-level tool lists as explicit include lists", () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-home-"));
    process.env.BUBBLE_HOME = home;
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "list-tools.md"), [
      "---",
      "name: list-tools",
      "description: List tools",
      "tools:",
      "  - read",
      "  - grep",
      "---",
      "Inspect with listed tools.",
    ].join("\n"));

    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "list-tools");

    expect(profile?.tools).toEqual({ preset: "explicit", include: ["read", "grep"] });
  });

  it("diagnoses write-capable and recursive tools before subagent execution", () => {
    const profile = {
      name: "unsafe",
      description: "Unsafe profile",
      source: "user" as const,
      mode: "readonly" as const,
      tools: {
        preset: "explicit" as const,
        include: ["read", "edit", "subagent"],
      },
      approval: "fail" as const,
      prompt: "Inspect safely.",
    };
    const diagnostics = validateAgentProfileTools([
      tool("read", "read"),
      tool("edit", "write_direct"),
      tool("subagent", "read"),
    ], profile);

    expect(diagnostics.filter((item) => item.severity === "error").map((item) => item.toolName)).toEqual(["edit", "subagent"]);
  });
});
