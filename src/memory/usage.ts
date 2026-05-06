import { MemoryDatabase } from "./db.js";
import { existsSync, readFileSync } from "node:fs";

const CITATION_BLOCK_RE = /<oai-mem-citation>[\s\S]*?<citation_entries>([\s\S]*?)<\/citation_entries>[\s\S]*?<\/oai-mem-citation>/g;
const SESSION_RE = /session:\s*([^\n]+)/i;

export function recordMemoryCitations(cwd: string, text: string): number {
  const sessionFiles: string[] = [];
  for (const match of text.matchAll(CITATION_BLOCK_RE)) {
    const entries = match[1] ?? "";
    for (const line of entries.split("\n")) {
      const session = line.match(SESSION_RE)?.[1]?.trim();
      if (session) sessionFiles.push(session);
      const citedPath = parseCitedPath(line);
      if (citedPath && existsSync(citedPath)) {
        const content = readFileSync(citedPath, "utf-8");
        const citedSession = content.match(SESSION_RE)?.[1]?.trim();
        if (citedSession) sessionFiles.push(citedSession);
      }
    }
  }
  if (sessionFiles.length === 0) return 0;
  const db = new MemoryDatabase(cwd);
  try {
    return db.recordUsage(sessionFiles);
  } finally {
    db.close();
  }
}

function parseCitedPath(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const path = trimmed.split("|", 1)[0]?.replace(/:\d+(?:-\d+)?$/, "");
  return path && path.startsWith("/") ? path : undefined;
}
