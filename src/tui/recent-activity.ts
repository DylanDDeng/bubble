import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { getSessionsDir } from "../session.js";

export interface RecentSession {
  file: string;
  modifiedAt: number;
  preview: string;
}

export function getRecentSessions(cwd: string, limit = 3): RecentSession[] {
  const dir = getSessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const withMtime = files.map((f) => {
    const full = path.join(dir, f);
    try {
      return { file: f, full, modifiedAt: statSync(full).mtimeMs };
    } catch {
      return { file: f, full, modifiedAt: 0 };
    }
  });
  withMtime.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return withMtime.slice(0, limit).map(({ file, full, modifiedAt }) => ({
    file,
    modifiedAt,
    preview: extractFirstUserMessage(full) ?? "(no messages)",
  }));
}

export function formatRelativeTime(timestampMs: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  const weeks = Math.floor(diffSec / 604800);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diffSec / (30 * 86400));
  return `${months}mo ago`;
}

function extractFirstUserMessage(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "user_message" && typeof entry.message?.content === "string") {
      return entry.message.content;
    }
  }
  return null;
}

export function truncatePreview(preview: string, maxLen: number): string {
  const firstLine = preview.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, Math.max(1, maxLen - 1)) + "…";
}
