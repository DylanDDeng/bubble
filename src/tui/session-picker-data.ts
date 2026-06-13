import type { SessionSummary } from "../session.js";
import { normalizeSingleLine, truncateVisual } from "../text-display.js";
import { formatRelativeTime } from "./recent-activity.js";

const SESSION_PICKER_LABEL_MAX_WIDTH = 72;

export interface SessionPickerEntry {
  /** Session title (or first-message preview when untitled). */
  label: string;
  /** Message count, e.g. "12 messages". */
  detail: string;
  /** Absolute path to the session .jsonl file. */
  value: string;
  /** "current" for the active session, otherwise a relative timestamp. */
  footer: string;
  /** "●" marks the active session. */
  gutter?: string;
}

export function buildSessionPickerEntries(
  summaries: SessionSummary[],
  activeFile: string | undefined,
  now = Date.now(),
): SessionPickerEntry[] {
  return summaries.map((summary) => {
    const isCurrent = summary.file === activeFile;
    const label = truncateVisual(
      normalizeSingleLine(summary.title || summary.preview || summary.name),
      SESSION_PICKER_LABEL_MAX_WIDTH,
    ) || summary.name;
    return {
      label,
      detail: `${summary.messageCount} message${summary.messageCount === 1 ? "" : "s"}`,
      value: summary.file,
      footer: isCurrent ? "current" : formatRelativeTime(summary.mtime, now),
      gutter: isCurrent ? "●" : undefined,
    };
  });
}

/** Default selection: the most recent session that is not the active one. */
export function preferredSessionPickerIndex(entries: Array<{ gutter?: string }>): number {
  const firstOther = entries.findIndex((entry) => entry.gutter !== "●");
  return firstOther >= 0 ? firstOther : 0;
}
