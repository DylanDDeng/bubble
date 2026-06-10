import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

export interface HookLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  eventName?: string;
  hookId?: string;
  decision?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HookLogOptions {
  bubbleHome?: string;
}

const MAX_RECENT_LOG_BYTES = 512 * 1024;

export function appendHookLog(entry: HookLogEntry, options: HookLogOptions = {}): void {
  const bubbleHome = options.bubbleHome ?? getBubbleHome();
  const dir = join(bubbleHome, "hooks");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entry.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Hook logging must never affect the agent run.
  }
}

export function readRecentHookLogs(limit = 30, options: HookLogOptions = {}): HookLogEntry[] {
  const bubbleHome = options.bubbleHome ?? getBubbleHome();
  const dir = join(bubbleHome, "hooks");
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse();
    const lines: string[] = [];
    for (const file of files) {
      const path = join(dir, file);
      const size = statSync(path).size;
      const text = readFileSync(path, "utf-8");
      const chunk = size > MAX_RECENT_LOG_BYTES
        ? text.slice(Math.max(0, text.length - MAX_RECENT_LOG_BYTES))
        : text;
      lines.unshift(...chunk.trimEnd().split("\n").filter(Boolean));
      if (lines.length >= limit) break;
    }
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as HookLogEntry;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is HookLogEntry => !!entry);
  } catch {
    return [];
  }
}
