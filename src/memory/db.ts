import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getMemoryPaths } from "./paths.js";

export type MemoryJobStatus = "pending" | "running" | "succeeded" | "failed";
export type MemoryMode = "enabled" | "disabled";

export interface Stage1Output {
  sessionFile: string;
  cwd: string;
  entryCount: number;
  sourceUpdatedAt: string;
  generatedAt: string;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug?: string;
  usageCount: number;
  lastUsage?: string;
  selectedForPhase2: boolean;
  selectedForPhase2SourceUpdatedAt?: string;
}

export interface MemoryJob {
  kind: string;
  jobKey: string;
  status: MemoryJobStatus;
  workerId?: string;
  leaseUntil?: number;
  retryAt?: number;
  inputWatermark: number;
  lastSuccessWatermark: number;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
}

const SCHEMA_VERSION = 1;
const GLOBAL_CONSOLIDATION_KIND = "memory_consolidate_global";
const GLOBAL_CONSOLIDATION_KEY = "global";
const PHASE1_KIND = "memory_phase1_extract";
const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): { changes?: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  pragma?(source: string): unknown;
  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result;
  close(): void;
}

type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;

export class MemoryDatabase {
  private db: SqliteDatabase;

  constructor(cwd: string) {
    const path = getMemoryPaths(cwd).globalDatabase;
    mkdirSync(dirname(path), { recursive: true });
    this.db = createDatabase(path);
    setWalMode(this.db);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  path(cwd: string): string {
    return getMemoryPaths(cwd).globalDatabase;
  }

  upsertStage1Output(output: Omit<Stage1Output, "usageCount" | "selectedForPhase2" | "lastUsage" | "selectedForPhase2SourceUpdatedAt">): void {
    this.db.prepare(`
      INSERT INTO memory_stage1_outputs (
        session_file, cwd, entry_count, source_updated_at, generated_at,
        raw_memory, rollout_summary, rollout_slug, usage_count, selected_for_phase2
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(session_file) DO UPDATE SET
        cwd = excluded.cwd,
        entry_count = excluded.entry_count,
        source_updated_at = excluded.source_updated_at,
        generated_at = excluded.generated_at,
        raw_memory = excluded.raw_memory,
        rollout_summary = excluded.rollout_summary,
        rollout_slug = excluded.rollout_slug,
        selected_for_phase2 = CASE
          WHEN memory_stage1_outputs.selected_for_phase2_source_updated_at = excluded.source_updated_at
          THEN memory_stage1_outputs.selected_for_phase2
          ELSE 0
        END
    `).run(
      output.sessionFile,
      output.cwd,
      output.entryCount,
      output.sourceUpdatedAt,
      output.generatedAt,
      output.rawMemory,
      output.rolloutSummary,
      output.rolloutSlug ?? null,
    );
  }

  getStage1Output(sessionFile: string): Stage1Output | undefined {
    const row = this.db.prepare("SELECT * FROM memory_stage1_outputs WHERE session_file = ?").get(sessionFile);
    return row ? mapStage1(row as Record<string, unknown>) : undefined;
  }

  claimPhase1Job(sessionFile: string, workerId: string, leaseSeconds: number): { claimed: boolean; reason?: string } {
    const now = unixNow();
    const leaseUntil = now + Math.max(0, leaseSeconds);
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM memory_jobs WHERE kind = ? AND job_key = ?")
        .get(PHASE1_KIND, sessionFile) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.prepare(`
          INSERT INTO memory_jobs (kind, job_key, status, worker_id, lease_until, started_at, input_watermark, last_success_watermark)
          VALUES (?, ?, 'running', ?, ?, ?, 0, 0)
        `).run(PHASE1_KIND, sessionFile, workerId, leaseUntil, now);
        return { claimed: true };
      }
      const job = mapJob(row);
      if (job.status === "running" && (job.leaseUntil ?? 0) > now) {
        return { claimed: false, reason: "already running" };
      }
      if ((job.retryAt ?? 0) > now) {
        return { claimed: false, reason: "retry backoff active" };
      }
      this.db.prepare(`
        UPDATE memory_jobs
        SET status = 'running', worker_id = ?, lease_until = ?, started_at = ?, finished_at = NULL, last_error = NULL
        WHERE kind = ? AND job_key = ?
      `).run(workerId, leaseUntil, now, PHASE1_KIND, sessionFile);
      return { claimed: true };
    });
    return tx();
  }

  finishPhase1Job(sessionFile: string, ok: boolean, error?: string): void {
    const now = unixNow();
    this.db.prepare(`
      UPDATE memory_jobs
      SET status = ?,
          finished_at = ?,
          lease_until = NULL,
          retry_at = ?,
          last_error = ?
      WHERE kind = ? AND job_key = ?
    `).run(
      ok ? "succeeded" : "failed",
      now,
      ok ? null : now + 3600,
      error ?? null,
      PHASE1_KIND,
      sessionFile,
    );
  }

  listStage1Outputs(limit = 40): Stage1Output[] {
    return this.db.prepare(`
      SELECT * FROM memory_stage1_outputs
      ORDER BY usage_count DESC, COALESCE(last_usage, generated_at) DESC, source_updated_at DESC
      LIMIT ?
    `).all(limit).map((row) => mapStage1(row as Record<string, unknown>));
  }

  listPreviouslySelectedNotIn(sessionFiles: string[]): Stage1Output[] {
    if (sessionFiles.length === 0) {
      return this.db.prepare("SELECT * FROM memory_stage1_outputs WHERE selected_for_phase2 = 1")
        .all()
        .map((row) => mapStage1(row as Record<string, unknown>));
    }
    const placeholders = sessionFiles.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT * FROM memory_stage1_outputs
      WHERE selected_for_phase2 = 1 AND session_file NOT IN (${placeholders})
      ORDER BY COALESCE(last_usage, generated_at) DESC
    `).all(...sessionFiles).map((row) => mapStage1(row as Record<string, unknown>));
  }

  markSelectedForPhase2(outputs: Stage1Output[]): void {
    const tx = this.db.transaction((items: Stage1Output[]) => {
      this.db.prepare("UPDATE memory_stage1_outputs SET selected_for_phase2 = 0").run();
      const stmt = this.db.prepare(`
        UPDATE memory_stage1_outputs
        SET selected_for_phase2 = 1,
            selected_for_phase2_source_updated_at = source_updated_at
        WHERE session_file = ?
      `);
      for (const item of items) stmt.run(item.sessionFile);
    });
    tx(outputs);
  }

  recordUsage(sessionFiles: string[], now = new Date()): number {
    const unique = [...new Set(sessionFiles)];
    const stmt = this.db.prepare(`
      UPDATE memory_stage1_outputs
      SET usage_count = usage_count + 1,
          last_usage = ?
      WHERE session_file = ?
    `);
    const tx = this.db.transaction((items: string[]) => {
      let count = 0;
      for (const item of items) {
        count += stmt.run(now.toISOString(), item).changes ?? 0;
      }
      return count;
    });
    return tx(unique) as number;
  }

  setThreadMemoryMode(sessionFile: string, mode: MemoryMode): void {
    this.db.prepare(`
      INSERT INTO memory_thread_modes (session_file, mode, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_file) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(sessionFile, mode, new Date().toISOString());
  }

  getThreadMemoryMode(sessionFile: string): MemoryMode {
    const row = this.db.prepare("SELECT mode FROM memory_thread_modes WHERE session_file = ?").get(sessionFile) as { mode?: string } | undefined;
    return row?.mode === "disabled" ? "disabled" : "enabled";
  }

  claimGlobalPhase2Job(workerId: string, leaseSeconds: number): { claimed: boolean; job?: MemoryJob; reason?: string } {
    const now = unixNow();
    const leaseUntil = now + Math.max(0, leaseSeconds);
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM memory_jobs WHERE kind = ? AND job_key = ?")
        .get(GLOBAL_CONSOLIDATION_KIND, GLOBAL_CONSOLIDATION_KEY) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.prepare(`
          INSERT INTO memory_jobs (kind, job_key, status, worker_id, lease_until, started_at, input_watermark, last_success_watermark)
          VALUES (?, ?, 'running', ?, ?, ?, 0, 0)
        `).run(GLOBAL_CONSOLIDATION_KIND, GLOBAL_CONSOLIDATION_KEY, workerId, leaseUntil, now);
        return { claimed: true, job: this.getGlobalPhase2Job() };
      }
      const job = mapJob(row);
      if (job.status === "running" && (job.leaseUntil ?? 0) > now) {
        return { claimed: false, job, reason: "already running" };
      }
      if ((job.retryAt ?? 0) > now) {
        return { claimed: false, job, reason: "retry backoff active" };
      }
      this.db.prepare(`
        UPDATE memory_jobs
        SET status = 'running', worker_id = ?, lease_until = ?, started_at = ?, finished_at = NULL, last_error = NULL
        WHERE kind = ? AND job_key = ?
      `).run(workerId, leaseUntil, now, GLOBAL_CONSOLIDATION_KIND, GLOBAL_CONSOLIDATION_KEY);
      return { claimed: true, job: this.getGlobalPhase2Job() };
    });
    return tx();
  }

  finishGlobalPhase2Job(ok: boolean, watermark: number, error?: string): void {
    const now = unixNow();
    this.db.prepare(`
      UPDATE memory_jobs
      SET status = ?,
          finished_at = ?,
          lease_until = NULL,
          retry_at = ?,
          last_error = ?,
          last_success_watermark = CASE WHEN ? THEN ? ELSE last_success_watermark END
      WHERE kind = ? AND job_key = ?
    `).run(
      ok ? "succeeded" : "failed",
      now,
      ok ? null : now + 3600,
      error ?? null,
      ok ? 1 : 0,
      watermark,
      GLOBAL_CONSOLIDATION_KIND,
      GLOBAL_CONSOLIDATION_KEY,
    );
  }

  getGlobalPhase2Job(): MemoryJob | undefined {
    const row = this.db.prepare("SELECT * FROM memory_jobs WHERE kind = ? AND job_key = ?")
      .get(GLOBAL_CONSOLIDATION_KIND, GLOBAL_CONSOLIDATION_KEY);
    return row ? mapJob(row as Record<string, unknown>) : undefined;
  }

  resetStageData(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_stage1_outputs").run();
      this.db.prepare("DELETE FROM memory_jobs").run();
    });
    tx();
  }

  stats(): { stage1Outputs: number; disabledThreads: number; jobs: MemoryJob[] } {
    const stage1Outputs = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_stage1_outputs").get() as { count: number }).count;
    const disabledThreads = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_thread_modes WHERE mode = 'disabled'").get() as { count: number }).count;
    const jobs = this.db.prepare("SELECT * FROM memory_jobs ORDER BY kind, job_key").all().map((row) => mapJob(row as Record<string, unknown>));
    return { stage1Outputs, disabledThreads, jobs };
  }

  private migrate(): void {
    this.db.prepare("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS memory_stage1_outputs (
        session_file TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        source_updated_at TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        raw_memory TEXT NOT NULL,
        rollout_summary TEXT NOT NULL,
        rollout_slug TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_usage TEXT,
        selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
        selected_for_phase2_source_updated_at TEXT
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS memory_jobs (
        kind TEXT NOT NULL,
        job_key TEXT NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT,
        lease_until INTEGER,
        retry_at INTEGER,
        input_watermark INTEGER NOT NULL DEFAULT 0,
        last_success_watermark INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT,
        PRIMARY KEY (kind, job_key)
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS memory_thread_modes (
        session_file TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
    this.db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  }
}

function mapStage1(row: Record<string, unknown>): Stage1Output {
  return {
    sessionFile: String(row.session_file),
    cwd: String(row.cwd),
    entryCount: Number(row.entry_count),
    sourceUpdatedAt: String(row.source_updated_at),
    generatedAt: String(row.generated_at),
    rawMemory: String(row.raw_memory),
    rolloutSummary: String(row.rollout_summary),
    rolloutSlug: typeof row.rollout_slug === "string" ? row.rollout_slug : undefined,
    usageCount: Number(row.usage_count ?? 0),
    lastUsage: typeof row.last_usage === "string" ? row.last_usage : undefined,
    selectedForPhase2: Number(row.selected_for_phase2 ?? 0) === 1,
    selectedForPhase2SourceUpdatedAt: typeof row.selected_for_phase2_source_updated_at === "string"
      ? row.selected_for_phase2_source_updated_at
      : undefined,
  };
}

function mapJob(row: Record<string, unknown>): MemoryJob {
  return {
    kind: String(row.kind),
    jobKey: String(row.job_key),
    status: isJobStatus(row.status) ? row.status : "pending",
    workerId: typeof row.worker_id === "string" ? row.worker_id : undefined,
    leaseUntil: typeof row.lease_until === "number" ? row.lease_until : undefined,
    retryAt: typeof row.retry_at === "number" ? row.retry_at : undefined,
    inputWatermark: Number(row.input_watermark ?? 0),
    lastSuccessWatermark: Number(row.last_success_watermark ?? 0),
    startedAt: typeof row.started_at === "number" ? row.started_at : undefined,
    finishedAt: typeof row.finished_at === "number" ? row.finished_at : undefined,
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
  };
}

function isJobStatus(value: unknown): value is MemoryJobStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed";
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function createDatabase(path: string): SqliteDatabase {
  if (isBunRuntime()) {
    const bunSqlite = require("bun:sqlite") as { Database: SqliteDatabaseConstructor };
    return new bunSqlite.Database(path);
  }
  const Database = require("better-sqlite3") as SqliteDatabaseConstructor;
  return new Database(path);
}

function setWalMode(db: SqliteDatabase): void {
  if (typeof db.pragma === "function") {
    db.pragma("journal_mode = WAL");
    return;
  }
  db.prepare("PRAGMA journal_mode = WAL").get();
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}
