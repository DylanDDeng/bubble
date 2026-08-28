/**
 * Background workflow run ledger (option C Phase 4).
 *
 * Owns run records, waiters, cancellation and the pending-delivery set —
 * everything about tracking a detached workflow EXCEPT actually executing the
 * script, which stays on Agent (it needs subagent dispatch, profiles and the
 * concurrency gate) and arrives here as the single injected `execute` callback.
 *
 * Delivery notices are PULLED (`drainDeliveryNotices`) rather than pushed into
 * the parent, matching ResultIntegrator.drainNotices: the ledger never holds a
 * reference back to the agent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBubbleHome } from "../../bubble-home.js";
import { composeAbortSignals } from "../budget-ledger.js";
import { buildWorkflowDeliveryNotice, renderWorkflowResultValue, type WorkflowRunRecord, type WorkflowRunSnapshot } from "./control.js";
import type { AgentProfile } from "../profiles.js";
import type { SubagentThreadSnapshot } from "../subagent-control.js";
import type { ToolUpdate } from "../../types.js";

export interface WorkflowExecuteOptions {
  script: string;
  args?: unknown;
  parentToolCallId: string;
  abortSignal?: AbortSignal;
  directEmit?: (update: ToolUpdate) => void;
  queueUpdates?: boolean;
  ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
  workflowRunId?: string;
}

export interface WorkflowExecuteOutcome {
  result: { ok: true; value: unknown } | { ok: false; error: string };
  agentCount: number;
  logs: string[];
  snapshots: SubagentThreadSnapshot[];
}

export interface WorkflowLedgerDeps {
  /** Runs the script. Supplied by Agent — the ledger never executes anything itself. */
  execute(cwd: string, options: WorkflowExecuteOptions): Promise<WorkflowExecuteOutcome>;
}

export class WorkflowLedger {
  private readonly deps: WorkflowLedgerDeps;
  private readonly runs = new Map<string, WorkflowRunRecord>();
  /** Completed runs whose result has not yet been announced to the parent. */
  private readonly pendingDeliveries = new Set<string>();

  constructor(deps: WorkflowLedgerDeps) {
    this.deps = deps;
  }

  hasRunning(): boolean {
    return [...this.runs.values()].some((record) => record.status === "running");
  }

  /**
   * Starts a workflow in the BACKGROUND: returns a runId immediately; the
   * script runs detached, its agents stream progress through the queued
   * channel (drained at turn boundaries like spawn_agent), and its result is
   * ingested at the next turn. Collect explicitly with wait().
   */
  start(
    cwd: string,
    options: {
      script: string;
      args?: unknown;
      title?: string;
      parentToolCallId: string;
      abortSignal?: AbortSignal;
      ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
    },
  ): { runId: string; title: string } {
    const runId = randomUUID();
    const abortController = new AbortController();
    const composed = composeAbortSignals([options.abortSignal, abortController.signal]);
    if (composed) {
      composed.addEventListener("abort", () => abortController.abort(composed.reason), { once: true });
    }
    const record: WorkflowRunRecord = {
      runId,
      title: options.title ?? "workflow",
      status: "running",
      agentCount: 0,
      snapshots: [],
      logs: [],
      abortController,
      waiters: new Set(),
      createdAt: Date.now(),
      parentToolCallId: options.parentToolCallId,
    };
    this.runs.set(runId, record);
    record.promise = this.deps.execute(cwd, {
      script: options.script,
      args: options.args,
      parentToolCallId: options.parentToolCallId,
      workflowRunId: runId,
      abortSignal: abortController.signal,
      queueUpdates: true,
      ensureProfileTrusted: options.ensureProfileTrusted,
    }).then((out) => {
      record.agentCount = out.agentCount;
      record.snapshots = out.snapshots;
      record.logs = out.logs;
      record.result = out.result;
      record.status = out.result.ok ? "completed" : (abortController.signal.aborted ? "cancelled" : "failed");
      if (out.result.ok) record.resultPath = persistWorkflowResult(runId, out.result.value);
    }, (error: any) => {
      record.result = { ok: false, error: error?.message || String(error) };
      record.status = "failed";
    }).finally(() => {
      record.updatedAt = Date.now();
      this.pendingDeliveries.add(runId);
      for (const waiter of record.waiters) waiter();
      record.waiters.clear();
    });
    return { runId, title: record.title };
  }

  /**
   * Blocks until a background workflow reaches a final state (or times out).
   * `timeoutMs` must already be normalized by the caller.
   */
  async wait(runId: string, timeoutMs: number): Promise<WorkflowRunSnapshot | undefined> {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    if (record.status === "running") {
      let waiter: (() => void) | undefined;
      await Promise.race([
        new Promise<void>((resolve) => { waiter = resolve; record.waiters.add(resolve); }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]).finally(() => { if (waiter) record.waiters.delete(waiter); });
    }
    if (record.status !== "running") this.pendingDeliveries.delete(runId);
    return this.snapshot(record);
  }

  /** Cancels a running background workflow. */
  close(runId: string): WorkflowRunSnapshot | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    if (record.status === "running") record.abortController.abort(new Error("workflow cancelled"));
    return this.snapshot(record);
  }

  list(): WorkflowRunSnapshot[] {
    return [...this.runs.values()].map((record) => this.snapshot(record));
  }

  /**
   * Completed background-workflow results to announce before the next turn
   * (§5 analog). Marks each record delivered, so a notice is emitted once.
   */
  drainDeliveryNotices(): string[] {
    if (this.pendingDeliveries.size === 0) return [];
    const notices: string[] = [];
    for (const runId of [...this.pendingDeliveries]) {
      this.pendingDeliveries.delete(runId);
      const record = this.runs.get(runId);
      if (!record || record.status === "running" || record.deliveredAt) continue;
      record.deliveredAt = Date.now();
      notices.push(buildWorkflowDeliveryNotice(this.snapshot(record)));
    }
    return notices;
  }

  private snapshot(record: WorkflowRunRecord): WorkflowRunSnapshot {
    return {
      runId: record.runId,
      title: record.title,
      status: record.status,
      agentCount: record.agentCount,
      result: record.result,
      resultPath: record.resultPath,
      logs: record.logs,
      snapshots: record.snapshots,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

function persistWorkflowResult(runId: string, value: unknown): string | undefined {
  try {
    const dir = join(getBubbleHome(), "workflows");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${runId}.result.txt`);
    writeFileSync(path, renderWorkflowResultValue(value));
    return path;
  } catch {
    return undefined;
  }
}
