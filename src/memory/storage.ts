import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Stage1Output } from "./db.js";
import { getMemoryPaths } from "./paths.js";
import { redactSecrets } from "./store.js";

export function ensureMemoryWorkspace(cwd: string): void {
  const paths = getMemoryPaths(cwd);
  mkdirSync(paths.globalRoot, { recursive: true });
  mkdirSync(paths.globalRolloutSummaries, { recursive: true });
  mkdirSync(paths.globalSkills, { recursive: true });
}

export function rebuildRawMemories(cwd: string, outputs: Stage1Output[], limit = 40): string {
  const paths = getMemoryPaths(cwd);
  ensureMemoryWorkspace(cwd);
  const retained = outputs.slice(0, limit);
  const lines = ["# Raw Memories", "", "Merged stage-1 raw memories (latest first):", ""];
  for (const output of retained) {
    lines.push(`## Session \`${output.sessionFile}\``);
    lines.push(`updated_at: ${output.sourceUpdatedAt}`);
    lines.push(`cwd: ${output.cwd}`);
    lines.push(`rollout_path: ${output.sessionFile}`);
    lines.push(`rollout_summary_file: ${rolloutSummaryFileName(output)}`);
    lines.push("");
    lines.push(redactSecrets(output.rawMemory).text.trim());
    lines.push("");
  }
  const content = `${lines.join("\n").trim()}\n`;
  writeFileSync(paths.globalRawMemories, content, "utf-8");
  return content;
}

export function syncRolloutSummaries(cwd: string, outputs: Stage1Output[], limit = 40): void {
  const paths = getMemoryPaths(cwd);
  ensureMemoryWorkspace(cwd);
  const retained = outputs.slice(0, limit);
  const keep = new Set(retained.map(rolloutSummaryFileName));
  if (existsSync(paths.globalRolloutSummaries)) {
    for (const file of readdirSync(paths.globalRolloutSummaries)) {
      if (file.endsWith(".md") && !keep.has(file)) {
        rmSync(join(paths.globalRolloutSummaries, file), { force: true });
      }
    }
  }
  for (const output of retained) {
    const lines = [
      `session: ${output.sessionFile}`,
      `updated_at: ${output.sourceUpdatedAt}`,
      `cwd: ${output.cwd}`,
      "",
      redactSecrets(output.rolloutSummary).text.trim(),
      "",
    ];
    writeFileSync(join(paths.globalRolloutSummaries, rolloutSummaryFileName(output)), lines.join("\n"), "utf-8");
  }
}

export function writeConsolidatedMemory(cwd: string, input: { memoryMd: string; memorySummaryMd: string }): void {
  const paths = getMemoryPaths(cwd);
  ensureMemoryWorkspace(cwd);
  writeFileSync(paths.globalMemory, normalizeMemoryMarkdown(input.memoryMd), "utf-8");
  writeFileSync(paths.globalSummary, normalizeSummaryMarkdown(input.memorySummaryMd), "utf-8");
}

export function clearGeneratedMemoryOutputs(cwd: string): void {
  const paths = getMemoryPaths(cwd);
  rmSync(paths.globalRawMemories, { force: true });
  rmSync(paths.globalMemory, { force: true });
  rmSync(paths.globalSummary, { force: true });
  if (!existsSync(paths.globalRolloutSummaries)) return;

  for (const file of readdirSync(paths.globalRolloutSummaries)) {
    if (file.endsWith(".md")) {
      rmSync(join(paths.globalRolloutSummaries, file), { force: true });
    }
  }
}

export function resetMemoryWorkspace(cwd: string): void {
  const paths = getMemoryPaths(cwd);
  rmSync(paths.globalRoot, { recursive: true, force: true });
}

export function rolloutSummaryFileName(output: Stage1Output): string {
  const timestamp = output.sourceUpdatedAt.replace(/[:.]/g, "-");
  const slug = slugify(output.rolloutSlug || output.sessionFile.split("/").pop()?.replace(/\.jsonl$/, "") || "rollout");
  return `${timestamp}-${slug}.md`;
}

function normalizeMemoryMarkdown(value: string): string {
  const cleaned = stripCodeFence(redactSecrets(value).text).trim();
  return `${cleaned.startsWith("#") ? cleaned : `# Bubble Memory\n\n${cleaned}`}\n`;
}

function normalizeSummaryMarkdown(value: string): string {
  const cleaned = stripCodeFence(redactSecrets(value).text).trim();
  return `${/^#\s+Bubble Memory Summary/m.test(cleaned) ? cleaned : `# Bubble Memory Summary\n\n${cleaned}`}\n`;
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "rollout";
}
