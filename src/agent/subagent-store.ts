/**
 * SubagentStore — single source of truth for child thread state.
 *
 * `list_agents`, the lifecycle reminder, TUI metadata, and persistence all
 * read from this store; there is never a second copy of state (design §2).
 *
 * Persistence (design §7): final-state children are written to
 * `<persistDir>/<agentId>.json` as snapshot + compacted message history, so a
 * later process can resume them via send_input. The on-disk schema carries
 * `finalReason` / `resumable` / `deliveredAt` — the fields the
 * reply protocol and delivery dedup depend on. Child transcripts never mix
 * into the parent transcript.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isFinalSubagentThreadStatus,
  type SubagentFinalReason,
  type SubagentThreadRecord,
  type SubagentThreadStatus,
} from "./subagent-control.js";
import type { AgentProfile } from "./profiles.js";
import type { Message } from "../types.js";
import type { ResolvedSubagentRoute } from "./categories.js";
import type { SubagentRunResult } from "./profiles.js";

const PERSIST_SCHEMA_VERSION = 1;

interface PersistedSubagent {
  version: number;
  agentId: string;
  runId: string;
  nickname: string;
  profile: AgentProfile;
  category?: string;
  route?: ResolvedSubagentRoute;
  parentToolCallId: string;
  parentToolName: string;
  status: SubagentThreadStatus;
  finalReason?: SubagentFinalReason;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: SubagentRunResult["usage"];
  error?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  messages?: Message[];
}

export class SubagentStore {
  private readonly threads = new Map<string, SubagentThreadRecord>();

  constructor(private readonly persistDir?: string) {}

  get(agentId: string): SubagentThreadRecord | undefined {
    return this.threads.get(agentId);
  }

  set(record: SubagentThreadRecord): void {
    this.threads.set(record.agentId, record);
  }

  values(): SubagentThreadRecord[] {
    return [...this.threads.values()];
  }

  active(): SubagentThreadRecord[] {
    return this.values().filter((record) => !isFinalSubagentThreadStatus(record.status));
  }

  activeCount(): number {
    return this.active().length;
  }

  byStatus(status: SubagentThreadStatus): SubagentThreadRecord[] {
    return this.values().filter((record) => record.status === status);
  }

  /**
   * Marks the moment a child's full summary first reached parent context
   * (via a wait_agent reply or an ingestion notice). Used to deduplicate the
   * three delivery channels (design §3.3). Idempotent.
   */
  markDelivered(agentId: string, at = Date.now()): void {
    const record = this.threads.get(agentId);
    if (record && record.deliveredAt === undefined) {
      record.deliveredAt = at;
      this.persist(record);
    }
  }

  notifyWaiters(record: SubagentThreadRecord): void {
    for (const waiter of record.waiters) {
      waiter();
    }
  }

  /** Writes a final-state child to disk so a later process can resume it. */
  persist(record: SubagentThreadRecord): void {
    if (!this.persistDir) return;
    if (!isFinalSubagentThreadStatus(record.status)) return;
    try {
      mkdirSync(this.persistDir, { recursive: true });
      const payload: PersistedSubagent = {
        version: PERSIST_SCHEMA_VERSION,
        agentId: record.agentId,
        runId: record.runId,
        nickname: record.nickname,
        profile: record.profile,
        category: record.category,
        route: record.route,
        parentToolCallId: record.parentToolCallId,
        parentToolName: record.parentToolName,
        status: record.status,
        finalReason: record.finalReason,
        task: record.task,
        summary: record.summary,
        toolNotes: record.toolNotes,
        usage: record.usage,
        error: record.error,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deliveredAt: record.deliveredAt,
        messages: record.agent?.messages ?? record.messages,
      };
      writeFileSync(join(this.persistDir, `${record.agentId}.json`), JSON.stringify(payload));
    } catch {
      // Persistence is best-effort; never fail the runtime over it.
    }
  }

  /**
   * Loads previously persisted children. Records come back in their final
   * state with the child history staged on `record.messages`; the next
   * dispatch rebuilds an Agent instance from it (cross-restart resume, §7).
   * In-memory records always win over disk.
   */
  loadPersisted(): void {
    if (!this.persistDir || !existsSync(this.persistDir)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(this.persistDir).filter((entry) => entry.endsWith(".json"));
    } catch {
      return;
    }
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.persistDir, entry), "utf8")) as PersistedSubagent;
        if (parsed.version !== PERSIST_SCHEMA_VERSION || !parsed.agentId) continue;
        if (this.threads.has(parsed.agentId)) continue;
        this.threads.set(parsed.agentId, {
          agentId: parsed.agentId,
          runId: parsed.runId,
          nickname: parsed.nickname,
          profile: parsed.profile,
          category: parsed.category,
          route: parsed.route,
          parentToolCallId: parsed.parentToolCallId,
          parentToolName: parsed.parentToolName,
          status: parsed.status,
          finalReason: parsed.finalReason,
          task: parsed.task,
          summary: parsed.summary,
          toolNotes: parsed.toolNotes ?? [],
          usage: parsed.usage,
          error: parsed.error,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          deliveredAt: parsed.deliveredAt,
          abortController: new AbortController(),
          waiters: new Set(),
          messages: parsed.messages,
        });
      } catch {
        // Skip unreadable entries; they are diagnostics, not state we own.
      }
    }
  }
}
