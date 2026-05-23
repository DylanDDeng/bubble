/**
 * Minimal JSONL logger for the Feishu host.
 *
 * Writes one line per event to `~/.bubble/feishu/logs/YYYY-MM-DD.log`.
 * Auto-rotates by date; old files (>7d) are deleted at startup.
 */

import { appendFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogsDir } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  phase?: string;
  scope?: string;
  chatId?: string;
  userId?: string;
  messageId?: string;
  error?: { message: string; name?: string; stack?: string };
  [key: string]: unknown;
}

export class FeishuLogger {
  private currentDate = "";
  private currentPath = "";

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    const ts = new Date();
    const dateKey = ts.toISOString().slice(0, 10);
    if (dateKey !== this.currentDate) {
      this.currentDate = dateKey;
      this.currentPath = join(getLogsDir(), `${dateKey}.log`);
    }
    const line = JSON.stringify({
      ts: ts.toISOString(),
      level,
      msg,
      ...fields,
    });
    try {
      appendFileSync(this.currentPath, line + "\n");
    } catch {
      // Logging failures must not crash the process.
    }
  }

  debug(msg: string, fields?: LogFields): void { this.log("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void { this.log("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.log("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.log("error", msg, fields); }

  /** Delete log files older than `maxAgeDays`. */
  pruneOldLogs(maxAgeDays: number = 7): void {
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const dir = getLogsDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".log")) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.mtimeMs < cutoffMs) unlinkSync(path);
      } catch {
        // skip
      }
    }
  }
}
