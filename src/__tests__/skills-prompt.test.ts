import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";
import { buildSkillCatalog, SKILL_CATALOG_DESC_CHARS } from "../skills/format.js";
import { buildContextUsageSnapshot } from "../context/usage.js";
import type { SkillSummary } from "../skills/types.js";
import { Agent } from "../agent.js";
import { buildToolPromptOptions } from "../tools/index.js";
import type { Provider, ToolRegistryEntry } from "../types.js";

const base = {
  configuredProvider: "openai",
  configuredModel: "gpt-5.4",
  configuredModelId: "openai:gpt-5.4",
  tools: ["read", "skill_search", "skill"],
};
const skills: SkillSummary[] = [
  { name: "zeta-user", description: "A user skill.", source: "user" },
  { name: "repo-review", description: "Review a codebase for architecture and risks.", tags: ["review"], source: "user" },
  { name: "bubble-design", description: "Design mockups on the Bubble canvas.", source: "configured" },
  { name: "house-style", description: "This project's writing rules.", source: "project" },
];

describe("skills catalog", () => {
  it("lists every skill's name and description as the last system prompt section", () => {
    const prompt = buildSystemPrompt({ ...base, skills, memoryPrompt: "Memory section." });
    expect(prompt.endsWith(
      [
        "## Skills",
        "Skills are task-specific instructions loaded on demand. When a task matches a skill below, call `skill` with its exact name before starting, then follow it. Load only what clearly applies.",
        "- house-style: This project's writing rules.",
        "- bubble-design: Design mockups on the Bubble canvas.",
        "- repo-review: Review a codebase for architecture and risks.",
        "- zeta-user: A user skill.",
      ].join("\n"),
    )).toBe(true);
    expect(prompt.indexOf("Memory section.")).toBeLessThan(prompt.indexOf("## Skills"));
    // The catalog replaces the search-first guideline, and tags stay out of it.
    expect(prompt).not.toContain("call skill_search to find relevant skills");
    expect(prompt).not.toContain("[tags:");
  });

  it("is byte-identical for the same skills in any order", () => {
    const a = buildSystemPrompt({ ...base, skills });
    const b = buildSystemPrompt({ ...base, skills: [...skills].reverse() });
    expect(a).toBe(b);
  });

  it("cuts long descriptions and points overflow to skill_search only when it exists", () => {
    const long = { name: "long", description: "x".repeat(400), source: "user" as const };
    const line = buildSkillCatalog([long]).text.split("\n").at(-1)!;
    expect(line.length).toBe("- long: ".length + SKILL_CATALOG_DESC_CHARS);
    expect(line.endsWith("…")).toBe(true);

    const many = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "d".repeat(80), source: "user" as const }));
    const searchable = buildSkillCatalog(many, { budgetChars: 1000, searchable: true });
    expect(searchable.listed).toBeGreaterThan(0);
    expect(searchable.listed + searchable.unlisted).toBe(40);
    expect(searchable.chars).toBeLessThanOrEqual(1000);
    expect(searchable.text).toContain(`… and ${searchable.unlisted} more skills not listed here; use skill_search to find them.`);
    expect(buildSkillCatalog(many, { budgetChars: 1000 }).text).not.toContain("skill_search");
  });

  it("falls back to search only when the catalog is off or skills are not passed", () => {
    for (const prompt of [
      buildSystemPrompt({ ...base, skills, skillCatalogChars: 0 }),
      buildSystemPrompt({ ...base }),
    ]) {
      expect(prompt).not.toContain("## Skills");
      expect(prompt).toContain("call skill_search to find relevant skills");
    }
  });

  it("is absent without the skill tool", () => {
    const prompt = buildSystemPrompt({ ...base, tools: ["read"], skills });
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("bubble-design");
  });

  it("is counted in context usage from the section the prompt carries", () => {
    const prompt = buildSystemPrompt({ ...base, skills, skillCatalogChars: 5000 });
    const usage = buildContextUsageSnapshot({
      providerId: "openai",
      modelId: "gpt-5.4",
      messages: [{ role: "system", content: prompt }],
      toolEntries: [],
      skills,
    });
    expect(usage.skillCount).toBe(4);
    expect(usage.buckets.skills.tokens).toBeGreaterThan(0);
    expect(usage.buckets.skills.detail).toBe("4 advertised skills");
  });

  it("survives prompt rebuilds and follows /skills changes through the agent's live options", () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    };
    const tool = (name: string): ToolRegistryEntry => ({
      name,
      readOnly: true,
      effect: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "" };
      },
    });
    const agent = new Agent({ provider, model: "gpt-5.4", tools: [tool("skill")], skills, skillCatalogChars: 5000 });
    const rebuild = () => buildSystemPrompt({ ...base, ...agent.getSystemPromptToolOptions() });
    expect(rebuild()).toContain("- bubble-design: Design mockups on the Bubble canvas.");
    agent.setSkillSummaries(skills.filter((s) => s.name !== "bubble-design"));
    expect(rebuild()).not.toContain("bubble-design");
    expect(rebuild()).toContain("- house-style:");
  });

  it("never splits an emoji when cutting a description", () => {
    const text = buildSkillCatalog([{ name: "emoji", description: "x".repeat(118) + "😀😀😀", source: "user" }]).text;
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(text.endsWith("😀…")).toBe(true);
  });

  it("does not mistake a \"## Skills\" heading in AGENTS.md or memory for the catalog", () => {
    const memoryPrompt = "## Skills\n- writing\n- reviewing\n- testing\n- shipping";
    const usage = (prompt: string) =>
      buildContextUsageSnapshot({ providerId: "openai", modelId: "gpt-5.4", messages: [{ role: "system", content: prompt }], toolEntries: [], skills });
    expect(usage(buildSystemPrompt({ ...base, skills, memoryPrompt })).skillCount).toBe(4);
    const off = usage(buildSystemPrompt({ ...base, skills, memoryPrompt, skillCatalogChars: 0 }));
    expect(off.skillCount).toBe(0);
    expect(off.buckets.skills.tokens).toBe(0);
  });

  it("counts only listed skills when the catalog is cut, not the overflow line", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `s-${String(i).padStart(2, "0")}`, description: "d".repeat(60), source: "user" as const }));
    const prompt = buildSystemPrompt({ ...base, skills: many, skillCatalogChars: 700 });
    const catalog = buildSkillCatalog(many, { budgetChars: 700, searchable: true });
    const usage = buildContextUsageSnapshot({ providerId: "openai", modelId: "gpt-5.4", messages: [{ role: "system", content: prompt }], toolEntries: [], skills: many });
    expect(catalog.unlisted).toBeGreaterThan(0);
    expect(usage.skillCount).toBe(catalog.listed);
  });

  it("builds the same prompt at startup and on every rebuild for the same state", () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    };
    const tool = (name: string): ToolRegistryEntry => ({
      name,
      readOnly: true,
      effect: "read",
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "" };
      },
    });
    const tools = [tool("read"), tool("skill_search"), tool("skill")];
    const shared = { configuredProvider: "openai", configuredModel: "gpt-5.4", configuredModelId: "openai:gpt-5.4", workingDir: "/repo", currentDate: "2026-10-03" };
    const startup = buildSystemPrompt({ ...shared, ...buildToolPromptOptions(tools), skills: [...skills].reverse(), skillCatalogChars: 5000 });
    const agent = new Agent({ provider, model: "gpt-5.4", tools, skills, skillCatalogChars: 5000 });
    expect(buildSystemPrompt({ ...shared, ...agent.getSystemPromptToolOptions() })).toBe(startup);
  });
});
