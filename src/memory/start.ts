import type { Message, ThinkingLevel } from "../types.js";
import { runMemoryPhase1, type Phase1Result } from "./phase1.js";
import { runMemoryPhase2, type Phase2Result } from "./phase2.js";

export interface MemoryStartupOptions {
  cwd: string;
  complete: (
    messages: Message[],
    options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel },
  ) => Promise<string>;
  model?: string;
  disabled?: boolean;
  minEntries?: number;
}

export interface MemoryStartupResult {
  status: "succeeded" | "skipped" | "failed";
  phase1?: Phase1Result;
  phase2?: Phase2Result;
  reason?: string;
}

export async function runMemoryStartupPipeline(options: MemoryStartupOptions): Promise<MemoryStartupResult> {
  if (options.disabled || isMemoryDisabled()) {
    return { status: "skipped", reason: "disabled by BUBBLE_MEMORY_AUTO" };
  }
  if (!options.model) {
    return { status: "skipped", reason: "no active model" };
  }
  const phase1 = await runMemoryPhase1({
    cwd: options.cwd,
    complete: options.complete,
    model: options.model,
    minEntries: options.minEntries,
  });
  const phase2 = await runMemoryPhase2({
    cwd: options.cwd,
    complete: options.complete,
    model: options.model,
  });
  return {
    status: phase2.status === "failed" || phase1.failed > 0 ? "failed" : "succeeded",
    phase1,
    phase2,
    reason: phase2.reason,
  };
}

export function startMemoryStartupTask(options: MemoryStartupOptions): void {
  if (options.disabled || isMemoryDisabled() || !options.model) return;
  void runMemoryStartupPipeline(options).catch(() => {
    // Startup memory is best-effort and must not take down the main session.
  });
}

export function formatMemoryStartupResult(result: MemoryStartupResult): string {
  if (result.status === "skipped") return `Memory startup skipped: ${result.reason ?? "not needed"}.`;
  const lines = [
    `Memory startup ${result.status}.`,
    result.phase1 ? `Phase 1: scanned ${result.phase1.scanned}, claimed ${result.phase1.claimed}, succeeded ${result.phase1.succeeded}, empty ${result.phase1.empty}, failed ${result.phase1.failed}, skipped ${result.phase1.skipped}.` : undefined,
    result.phase2 ? `Phase 2: ${result.phase2.status}, selected ${result.phase2.selected}${result.phase2.reason ? ` (${result.phase2.reason})` : ""}.` : undefined,
    result.phase2?.memoryPath ? `Memory: ${result.phase2.memoryPath}` : undefined,
    result.phase2?.summaryPath ? `Summary: ${result.phase2.summaryPath}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

export function isMemoryDisabled(): boolean {
  const value = process.env.BUBBLE_MEMORY_AUTO?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}
