/**
 * Eval harness: runs one task under one config in an isolated temp workspace,
 * through the real BubbleSdk (real tools, real provider, real session file).
 * Follows the pi/vitest-evals methodology: scores are observations for a
 * comparison table, not CI assertions.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BubbleSdk } from "../src/sdk/index.js";
import type { EvalConfig, EvalTask, RunRecord } from "./types.js";

export interface HarnessOptions {
  /** Directory where session artifacts land (one file per run). */
  artifactDir: string;
  /** Per-run wall-clock cap in ms. */
  timeoutMs: number;
}

export async function runTaskOnce(
  sdk: BubbleSdk,
  task: EvalTask,
  config: EvalConfig,
  repetition: number,
  options: HarnessOptions,
): Promise<RunRecord> {
  const workspace = mkdtempSync(join(tmpdir(), `bubble-eval-${task.id}-`));
  const record: RunRecord = {
    taskId: task.id,
    configName: config.name,
    repetition,
    pass: false,
    wallMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    turns: 0,
  };

  const session = sdk.createSession({ cwd: workspace });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs);
  const startedAt = Date.now();

  try {
    await task.setup(workspace);

    let costUsd: number | undefined;
    const turn = sdk.runTurn(session.id, {
      prompt: task.prompt,
      model: config.model,
      thinkingLevel: config.thinkingLevel as never,
      appendSystemPrompt: config.appendSystemPrompt,
      mode: "bypassPermissions",
      signal: abort.signal,
      // bypassPermissions auto-approves; this is the belt for anything that
      // still asks (e.g. rules downgrading a call back to prompt).
      onApproval: async () => ({ action: "approve" }),
      onQuestion: async () => null,
      onPlanApproval: async () => true,
      // Record what actually ran: an unset thinkingLevel resolves through the
      // machine's user config, and a comparison is only as clean as this field.
      onStart: (info) => {
        record.resolvedModel = info.model;
        record.resolvedThinkingLevel = info.thinkingLevel;
      },
    });
    for await (const event of turn) {
      if (event.type === "turn_end") {
        record.turns += 1;
        if (event.usage) {
          record.promptTokens += event.usage.promptTokens ?? 0;
          record.completionTokens += event.usage.completionTokens ?? 0;
        }
        if (event.cost?.currency === "USD") {
          costUsd = (costUsd ?? 0) + event.cost.cost;
        }
      }
    }
    record.costUsd = costUsd;

    if (abort.signal.aborted) {
      record.error = `timeout after ${options.timeoutMs}ms`;
    } else {
      const score = await task.score(workspace);
      record.pass = score.pass;
      record.notes = score.notes;
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    record.wallMs = Date.now() - startedAt;
    record.sessionArtifact = archiveSession(sdk, session.id, task, config, repetition, options.artifactDir);
    sdk.deleteSession(session.id);
    rmSync(workspace, { recursive: true, force: true });
  }
  return record;
}

/** Copy the raw session JSONL into the artifact dir so every run is replayable. */
function archiveSession(
  sdk: BubbleSdk,
  sessionId: string,
  task: EvalTask,
  config: EvalConfig,
  repetition: number,
  artifactDir: string,
): string | undefined {
  try {
    const history = sdk.getHistory(sessionId);
    if (history.length === 0) return undefined;
    mkdirSync(artifactDir, { recursive: true });
    const sessions = sdk.listSessions();
    const match = sessions.find((s) => s.name === sessionId);
    if (!match) return undefined;
    const target = join(artifactDir, `${task.id}__${config.name}__r${repetition}.jsonl`);
    cpSync(match.file, target);
    return target;
  } catch {
    return undefined;
  }
}
