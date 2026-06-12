/**
 * ResultIntegrator — turns background child completions into ingestion
 * notices injected before the parent's next inference turn (design doc §5).
 *
 * Injection marks the child as delivered (§3.3), so the lifecycle reminder
 * demotes it to a one-liner and the same summary never appears twice in full
 * form in the parent transcript.
 */

import { fenceChildOutput } from "./subagent-summary.js";
import type { SubagentThreadRecord } from "./subagent-control.js";
import type { SubagentStore } from "./subagent-store.js";

export class ResultIntegrator {
  private readonly pending: string[] = [];

  enqueue(agentId: string): void {
    if (!this.pending.includes(agentId)) {
      this.pending.push(agentId);
    }
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Builds notices for children whose results have not yet reached parent
   * context, marking them delivered. Already-delivered children (e.g. the
   * model wait_agent-ed first) are skipped silently.
   */
  drainNotices(store: SubagentStore, now = Date.now()): string[] {
    const ids = this.pending.splice(0, this.pending.length);
    const notices: string[] = [];
    for (const id of ids) {
      const record = store.get(id);
      if (!record || record.deliveredAt !== undefined) continue;
      notices.push(buildIngestionNotice(record));
      store.markDelivered(id, now);
    }
    return notices;
  }
}

export function buildIngestionNotice(record: SubagentThreadRecord): string {
  const lines = [
    `subagent ${record.nickname} (agent_id: ${record.agentId}) ${record.status}.`,
  ];
  if (record.error) {
    lines.push(`error: ${record.error}`);
  }
  if (record.summary) {
    lines.push(fenceChildOutput(record.summary));
  }
  lines.push("Full result via wait_agent. Do not redo this delegated work.");
  return lines.join("\n");
}
