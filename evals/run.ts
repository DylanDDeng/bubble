/**
 * Comparative eval runner. Runs real Bubble agent sessions (via BubbleSdk,
 * with the user's configured providers) against the task set in tasks.ts.
 *
 *   bun evals/run.ts --model deepseek:deepseek-v4-flash
 *   bun evals/run.ts --baseline '{"model":"deepseek:deepseek-v4-pro"}' \
 *                    --candidate '{"model":"deepseek:deepseek-v4-pro","appendSystemPrompt":"..."}' \
 *                    --reps 3 --tasks fix-off-by-one,rename-symbol
 *
 * Config JSON fields: {name?, model?, thinkingLevel?, appendSystemPrompt?}.
 * A bare string is shorthand for {"model": "<string>"}.
 * Artifacts (runs.jsonl + per-run session files) land in .eval/<timestamp>/.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { BubbleSdk } from "../src/sdk/index.js";
import { runTaskOnce } from "./harness.js";
import { formatReport } from "./report.js";
import { selectTasks } from "./tasks.js";
import type { EvalConfig, RunRecord } from "./types.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function parseConfig(raw: string, fallbackName: string): EvalConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim().startsWith("{") ? JSON.parse(raw) : { model: raw };
  } catch (error) {
    throw new Error(`Config "${raw}" is not valid JSON: ${(error as Error).message}`);
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : fallbackName,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : undefined,
    appendSystemPrompt: typeof parsed.appendSystemPrompt === "string" ? parsed.appendSystemPrompt : undefined,
  };
}

const baselineRaw = flag("baseline");
const candidateRaw = flag("candidate");
if (candidateRaw && !baselineRaw) {
  throw new Error("--candidate requires --baseline");
}

const configs: EvalConfig[] = baselineRaw
  ? [
      parseConfig(baselineRaw, "baseline"),
      ...(candidateRaw ? [parseConfig(candidateRaw, "candidate")] : []),
    ]
  : [{ name: "default", model: flag("model"), thinkingLevel: flag("thinking") }];

const tasks = selectTasks(flag("tasks"));
const reps = Number(flag("reps") ?? "1");
const timeoutMs = Number(flag("timeout") ?? "300") * 1000;
if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = join(process.cwd(), ".eval", stamp);
mkdirSync(artifactDir, { recursive: true });
const runsFile = join(artifactDir, "runs.jsonl");

// mcp: false — eval runs must be hermetic, never coupled to whatever MCP
// servers happen to be configured on the machine running them.
const sdk = new BubbleSdk({ defaultCwd: process.cwd(), mcp: false });
const records: RunRecord[] = [];
const totalRuns = tasks.length * configs.length * reps;
let done = 0;

console.log(`${tasks.length} task(s) × ${configs.length} config(s) × ${reps} rep(s) = ${totalRuns} runs`);
console.log(`artifacts: ${artifactDir}\n`);

for (let rep = 1; rep <= reps; rep += 1) {
  for (const task of tasks) {
    // Interleave configs within a task/rep so time-of-day drift (provider
    // load, cache warmth) spreads evenly across both sides of a comparison.
    for (const config of configs) {
      const record = await runTaskOnce(sdk, task, config, rep, { artifactDir, timeoutMs });
      records.push(record);
      appendFileSync(runsFile, JSON.stringify(record) + "\n");
      done += 1;
      const status = record.error ? `ERROR ${record.error.slice(0, 60)}` : record.pass ? "pass" : `FAIL ${record.notes ?? ""}`;
      console.log(`[${done}/${totalRuns}] ${task.id} · ${config.name} · ${status} (${Math.round(record.wallMs / 1000)}s)`);
    }
  }
}

const report = formatReport(records, configs.map((config) => config.name));
console.log("\n" + report);
writeFileSync(join(artifactDir, "summary.txt"), report + "\n");
