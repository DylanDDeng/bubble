import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

const MAX_HISTORY_ENTRIES = 1000;

export function defaultHistoryFilePath(): string {
  return join(getBubbleHome(), "input-history.jsonl");
}

// JSONL on disk: each line is a JSON-encoded string. JSON encoding handles
// embedded newlines and quotes so multi-line composer entries round-trip safely.
export function loadHistorySync(filePath: string = defaultHistoryFilePath()): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === "string" && parsed.length > 0) out.push(parsed);
      } catch {
        // Malformed line — skip rather than fail the whole load.
      }
    }
    return out.length > MAX_HISTORY_ENTRIES ? out.slice(-MAX_HISTORY_ENTRIES) : out;
  } catch {
    return [];
  }
}

export function appendHistoryEntry(entry: string, filePath: string = defaultHistoryFilePath()): void {
  if (!entry || entry.trim().length === 0) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Persistence is best-effort; never crash the composer over disk IO.
  }
}

export interface HistoryNavState {
  history: string[];
  index: number | null;
  draft: string;
}

export interface HistoryNavResult {
  text: string;
  index: number | null;
  draft: string;
  changed: boolean;
}

// Pure transition for ↑/↓ navigation. `index === null` means the user is
// editing a fresh draft; otherwise it points at history[index]. When stepping
// from the draft into history we snapshot the current text so ↓ past the
// newest entry can restore it.
export function stepHistory(
  state: HistoryNavState,
  direction: "up" | "down",
  currentText: string,
): HistoryNavResult {
  const { history, index, draft } = state;
  const noChange: HistoryNavResult = { text: currentText, index, draft, changed: false };

  if (direction === "up") {
    if (history.length === 0) return noChange;
    if (index === null) {
      const newIdx = history.length - 1;
      return { text: history[newIdx], index: newIdx, draft: currentText, changed: true };
    }
    if (index > 0) {
      return { text: history[index - 1], index: index - 1, draft, changed: true };
    }
    return noChange;
  }

  // down
  if (index === null) return noChange;
  if (index < history.length - 1) {
    return { text: history[index + 1], index: index + 1, draft, changed: true };
  }
  // Past the newest entry: restore the saved draft and clear it.
  return { text: draft, index: null, draft: "", changed: true };
}

// Push to in-memory history with last-entry dedupe so repeated identical
// submissions don't spam the stack.
export function pushHistoryEntry(history: string[], entry: string): string[] {
  if (!entry || entry.trim().length === 0) return history;
  if (history.length > 0 && history[history.length - 1] === entry) return history;
  return [...history, entry];
}
