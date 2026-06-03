import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMemoryPrompt,
  getMemoryPaths,
  MemoryDatabase,
  resetMemory,
  runMemoryPhase1,
  runMemoryPhase2,
  runMemoryStartupPipeline,
  recordMemoryCitations,
} from "../memory/index.js";
import { SessionManager } from "../session.js";

describe("memory", () => {
  const originalBubbleHome = process.env.BUBBLE_HOME;

  afterEach(() => {
    if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = originalBubbleHome;
  });

  it("builds Codex-style read path from global memory summary and AGENTS files", () => {
    const { cwd, home } = setupWorkspace("bubble-memory-prompt");
    process.env.BUBBLE_HOME = home;
    const paths = getMemoryPaths(cwd);
    mkdirSync(paths.globalRoot, { recursive: true });
    writeFileSync(paths.globalAgents, "Use concise answers.\n", "utf-8");
    writeFileSync(paths.globalSummary, "# Bubble Memory Summary\n\n- This repo uses React Ink.\n", "utf-8");

    const prompt = buildMemoryPrompt(cwd);
    expect(prompt).toContain("Global AGENTS.md");
    expect(prompt).toContain("Use concise answers.");
    expect(prompt).toContain("## Persistent Memory");
    expect(prompt).toContain("memory_summary.md");
    expect(prompt).toContain("This repo uses React Ink.");
    expect(prompt).toContain("Use memory quietly");
    expect(prompt).not.toContain("cite the memory files");
  });

  it("runs phase 1 over historical session rollouts and stores DB-backed stage outputs", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-phase1");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "phase1.jsonl");

    const result = await runMemoryPhase1({
      cwd,
      model: "gpt-test",
      complete: async () => JSON.stringify({
        raw_memory: "Bubble phase 1 creates raw rollout memories.",
        rollout_summary: "Phase 1 extracted a compact rollout summary.",
        rollout_slug: "phase-one-memory",
      }),
    });

    const db = new MemoryDatabase(cwd);
    const outputs = db.listStage1Outputs();
    db.close();

    expect(result.scanned).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].rawMemory).toContain("phase 1 creates raw");
    expect(outputs[0].rolloutSlug).toBe("phase-one-memory");
  });

  it("extracts global memories across project sessions from any startup cwd", async () => {
    const { root, home } = setupWorkspace("bubble-memory-cross-project");
    process.env.BUBBLE_HOME = home;
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(join(projectA, ".git"), { recursive: true });
    mkdirSync(join(projectB, ".git"), { recursive: true });
    createSession(projectA, "project-a.jsonl", "Project A uses pnpm build for release checks.");
    createSession(projectB, "project-b.jsonl", "Project B keeps browser smoke tests in Playwright.");

    const phase1 = await runMemoryPhase1({
      cwd: projectB,
      model: "gpt-test",
      complete: async (messages) => {
        const content = String(messages[1].content);
        return JSON.stringify(content.includes(projectA)
          ? {
            raw_memory: "Project A uses pnpm build for release checks.",
            rollout_summary: "Project A release checks use pnpm build.",
            rollout_slug: "project-a-release-checks",
          }
          : {
            raw_memory: "Project B keeps browser smoke tests in Playwright.",
            rollout_summary: "Project B browser checks use Playwright.",
            rollout_slug: "project-b-browser-checks",
          });
      },
    });

    const db = new MemoryDatabase(projectB);
    const outputs = db.listStage1Outputs();
    db.close();
    expect(phase1.scanned).toBe(2);
    expect(phase1.succeeded).toBe(2);
    expect(outputs.map((output) => output.cwd).sort()).toEqual([projectA, projectB].sort());

    const phase2 = await runMemoryPhase2({
      cwd: projectB,
      model: "gpt-test",
      complete: async (messages) => {
        expect(messages[1].content).toContain("Project A uses pnpm build");
        expect(messages[1].content).toContain("Project B keeps browser smoke tests");
        return JSON.stringify({
          memory_md: "# Bubble Memory\n\n- Project A uses pnpm build.\n- Project B uses Playwright smoke tests.",
          memory_summary_md: "# Bubble Memory Summary\n\n- Cross-project memories are globally available.",
        });
      },
    });

    expect(phase2.status).toBe("succeeded");
    expect(buildMemoryPrompt(projectA)).toContain("Cross-project memories are globally available");
    expect(buildMemoryPrompt(projectB)).toContain("Cross-project memories are globally available");
  });

  it("runs phase 2 consolidation into Codex-style memory artifacts", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-phase2");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "phase2.jsonl");
    await runMemoryPhase1({
      cwd,
      model: "gpt-test",
      complete: async () => JSON.stringify({
        raw_memory: "Use npm run build after memory refactors.",
        rollout_summary: "Build verification is required after memory refactors.",
        rollout_slug: "build-verification",
      }),
    });

    const result = await runMemoryPhase2({
      cwd,
      model: "gpt-test",
      complete: async (messages) => {
        expect(messages[1].content).toContain("Use npm run build");
        return JSON.stringify({
          memory_md: "# Bubble Memory\n\n## Workflows\n- Use npm run build after memory refactors.",
          memory_summary_md: "# Bubble Memory Summary\n\n## Workflows\n- Build after memory refactors.",
        });
      },
    });

    const paths = getMemoryPaths(cwd);
    const summaries = readdirSync(paths.globalRolloutSummaries);
    expect(result.status).toBe("succeeded");
    expect(readFileSync(paths.globalRawMemories, "utf-8")).toContain("Use npm run build");
    expect(readFileSync(paths.globalMemory, "utf-8")).toContain("Bubble Memory");
    expect(readFileSync(paths.globalSummary, "utf-8")).toContain("Build after memory refactors");
    expect(summaries[0]).toContain("build-verification");
  });

  it("writes fallback memory artifacts before model consolidation returns", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-phase2-fallback");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "phase2-fallback.jsonl");
    await runMemoryPhase1({
      cwd,
      model: "gpt-test",
      complete: async () => JSON.stringify({
        raw_memory: "Fallback memory should be visible while consolidation is still running.",
        rollout_summary: "Fallback summaries are written before the consolidation model returns.",
        rollout_slug: "fallback-memory",
      }),
    });

    const paths = getMemoryPaths(cwd);
    await runMemoryPhase2({
      cwd,
      model: "gpt-test",
      complete: async () => {
        expect(readFileSync(paths.globalMemory, "utf-8")).toContain("Fallback memory should be visible");
        expect(readFileSync(paths.globalSummary, "utf-8")).toContain("Fallback summaries are written");
        return JSON.stringify({
          memory_md: "# Bubble Memory\n\n- Consolidated fallback memory.",
          memory_summary_md: "# Bubble Memory Summary\n\n- Consolidated fallback summary.",
        });
      },
    });

    expect(readFileSync(paths.globalMemory, "utf-8")).toContain("Consolidated fallback memory");
  });

  it("runs the startup pipeline end to end without manual governance", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-startup");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "startup.jsonl");

    const result = await runMemoryStartupPipeline({
      cwd,
      model: "gpt-test",
      complete: async (messages) => {
        if (String(messages[0].content).includes("phase-1")) {
          return JSON.stringify({
            raw_memory: "Startup pipeline extracts memories automatically.",
            rollout_summary: "Automatic startup memory extraction landed.",
            rollout_slug: "startup-memory",
          });
        }
        return JSON.stringify({
          memory_md: "# Bubble Memory\n\n- Startup pipeline extracts memories automatically.",
          memory_summary_md: "# Bubble Memory Summary\n\n- Startup memory is automatic.",
        });
      },
    });

    const paths = getMemoryPaths(cwd);
    expect(result.status).toBe("succeeded");
    expect(existsSync(paths.globalDatabase)).toBe(true);
    expect(existsSync(paths.globalMemory)).toBe(true);
    expect(existsSync(paths.globalSummary)).toBe(true);
  });

  it("resets memory artifacts and DB-backed stage data", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-reset");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "reset.jsonl");
    await runMemoryStartupPipeline({
      cwd,
      model: "gpt-test",
      complete: async (messages) => String(messages[0].content).includes("phase-1")
        ? JSON.stringify({
          raw_memory: "Reset test raw memory.",
          rollout_summary: "Reset test summary.",
          rollout_slug: "reset-test",
        })
        : JSON.stringify({
          memory_md: "# Bubble Memory\n\n- Reset test raw memory.",
          memory_summary_md: "# Bubble Memory Summary\n\n- Reset test.",
        }),
    });

    const paths = getMemoryPaths(cwd);
    expect(existsSync(paths.globalMemory)).toBe(true);
    expect(resetMemory(cwd)).toContain("complete");
    expect(existsSync(paths.globalMemory)).toBe(false);
    expect(existsSync(paths.globalDatabase)).toBe(false);
  });

  it("records memory usage from cited rollout summary files", async () => {
    const { cwd, home } = setupWorkspace("bubble-memory-usage");
    process.env.BUBBLE_HOME = home;
    createSession(cwd, "usage.jsonl");
    await runMemoryPhase1({
      cwd,
      model: "gpt-test",
      complete: async () => JSON.stringify({
        raw_memory: "Usage tracking should reward cited memories.",
        rollout_summary: "Usage tracking summary.",
        rollout_slug: "usage-tracking",
      }),
    });
    await runMemoryPhase2({
      cwd,
      model: "gpt-test",
      complete: async () => JSON.stringify({
        memory_md: "# Bubble Memory\n\n- Usage tracking should reward cited memories.",
        memory_summary_md: "# Bubble Memory Summary\n\n- Usage tracking exists.",
      }),
    });
    const paths = getMemoryPaths(cwd);
    const summaryFile = join(paths.globalRolloutSummaries, readdirSync(paths.globalRolloutSummaries)[0]!);

    const count = recordMemoryCitations(cwd, [
      "<oai-mem-citation>",
      "<citation_entries>",
      `${summaryFile}:1-3|note=[used rollout summary]`,
      "</citation_entries>",
      "<rollout_ids>",
      "</rollout_ids>",
      "</oai-mem-citation>",
    ].join("\n"));

    const db = new MemoryDatabase(cwd);
    const output = db.listStage1Outputs()[0];
    db.close();
    expect(count).toBe(1);
    expect(output.usageCount).toBe(1);
    expect(output.lastUsage).toBeTruthy();
  });
});

function setupWorkspace(prefix: string): { root: string; cwd: string; home: string } {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { root, cwd, home };
}

function createSession(cwd: string, name: string, firstUserMessage = "Implement Codex-style memory."): SessionManager {
  const session = SessionManager.create(cwd, name);
  session.setMetadata({ cwd });
  session.appendMessage({ role: "user", content: firstUserMessage });
  session.appendMessage({ role: "assistant", content: "Added phase one and phase two memory pipeline." });
  session.appendMarker("mode_switch", "default");
  session.appendMessage({ role: "user", content: "Run verification." });
  session.appendMessage({ role: "assistant", content: "npm run build passed." });
  return session;
}
