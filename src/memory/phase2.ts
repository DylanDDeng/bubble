import { randomUUID } from "node:crypto";
import type { Message, ThinkingLevel } from "../types.js";
import { MemoryDatabase, type Stage1Output } from "./db.js";
import { getMemoryPaths } from "./paths.js";
import { buildConsolidationMessages, parseJsonObject } from "./prompts.js";
import { rebuildRawMemories, syncRolloutSummaries, writeConsolidatedMemory } from "./storage.js";

export interface Phase2Options {
  cwd: string;
  complete: (
    messages: Message[],
    options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel },
  ) => Promise<string>;
  model?: string;
  limit?: number;
}

export interface Phase2Result {
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
  selected: number;
  memoryPath?: string;
  summaryPath?: string;
}

const DEFAULT_SELECTION_LIMIT = 40;

export async function runMemoryPhase2(options: Phase2Options): Promise<Phase2Result> {
  if (!options.model) {
    return { status: "skipped", reason: "no active model", selected: 0 };
  }

  const db = new MemoryDatabase(options.cwd);
  const paths = getMemoryPaths(options.cwd);
  const workerId = randomUUID();
  const claim = db.claimGlobalPhase2Job(workerId, 3600);
  if (!claim.claimed) {
    db.close();
    return { status: "skipped", reason: claim.reason ?? "phase2 unavailable", selected: 0 };
  }

  try {
    const selected = db.listStage1Outputs(options.limit ?? DEFAULT_SELECTION_LIMIT);
    if (selected.length === 0) {
      db.finishGlobalPhase2Job(true, Date.now());
      return { status: "skipped", reason: "no stage-1 outputs", selected: 0 };
    }

    const retained = selected.filter((item) => item.selectedForPhase2);
    const removed = db.listPreviouslySelectedNotIn(selected.map((item) => item.sessionFile));
    syncRolloutSummaries(options.cwd, selected);
    const rawMemories = rebuildRawMemories(options.cwd, selected);
    writeConsolidatedMemory(options.cwd, buildFallbackConsolidatedMemory(selected));
    const raw = await options.complete(buildConsolidationMessages({
      memoryRoot: paths.globalRoot,
      selected,
      retained,
      removed,
      rawMemories,
    }), {
      model: options.model,
      temperature: 0,
      thinkingLevel: "off",
    });
    const parsed = parseJsonObject(raw);
    const memoryMd = stringField(parsed.memory_md);
    const memorySummaryMd = stringField(parsed.memory_summary_md);
    if (!memoryMd || !memorySummaryMd) {
      throw new Error("consolidation output must include memory_md and memory_summary_md");
    }
    writeConsolidatedMemory(options.cwd, { memoryMd, memorySummaryMd });
    db.markSelectedForPhase2(selected);
    db.finishGlobalPhase2Job(true, Date.now());
    return {
      status: "succeeded",
      selected: selected.length,
      memoryPath: paths.globalMemory,
      summaryPath: paths.globalSummary,
    };
  } catch (error) {
    db.finishGlobalPhase2Job(false, Date.now(), error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      selected: 0,
    };
  } finally {
    db.close();
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildFallbackConsolidatedMemory(selected: Stage1Output[]): { memoryMd: string; memorySummaryMd: string } {
  const memoryLines = [
    "# Bubble Memory",
    "",
    "This deterministic memory snapshot was generated from completed phase-1 extraction outputs. It may be replaced by a model-consolidated version when phase 2 finishes.",
    "",
  ];
  const summaryLines = [
    "# Bubble Memory Summary",
    "",
    "Model consolidation is in progress or previously failed, so this summary is derived directly from extracted rollout summaries.",
    "",
  ];

  for (const item of selected) {
    const title = item.rolloutSlug || item.sessionFile.split("/").pop()?.replace(/\.jsonl$/, "") || "rollout";
    memoryLines.push(`## ${title}`);
    memoryLines.push(`cwd: ${item.cwd}`);
    memoryLines.push(`rollout_path: ${item.sessionFile}`);
    memoryLines.push("");
    memoryLines.push(item.rawMemory.trim());
    memoryLines.push("");

    const summary = item.rolloutSummary.trim();
    summaryLines.push(`- ${item.cwd}: ${summary}`);
  }

  return {
    memoryMd: memoryLines.join("\n").trim(),
    memorySummaryMd: summaryLines.join("\n").trim(),
  };
}
