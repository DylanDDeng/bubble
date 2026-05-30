import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeInternalReminderBlocks } from "./agent/internal-reminder-sanitizer.js";

const DEBUG_PATH = process.env.BUBBLE_DEBUG_REASONING_STREAM?.trim();
const INCLUDE_PREVIEW = process.env.BUBBLE_DEBUG_REASONING_PREVIEW !== "0";
const INCLUDE_RAW_PREVIEW = ["1", "true", "yes", "on"].includes(
  process.env.BUBBLE_DEBUG_REASONING_RAW?.trim().toLowerCase() ?? "",
);
const PREVIEW_CHARS = 180;

let sequence = 0;

export interface DebugTextSummary {
  length: number;
  hash: string;
  preview?: string;
}

export function summarizeDebugText(value: unknown): DebugTextSummary | undefined {
  if (!DEBUG_PATH) return undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const summary: DebugTextSummary = { length: value.length, hash };
  if (INCLUDE_PREVIEW) {
    const previewValue = INCLUDE_RAW_PREVIEW ? value : sanitizeInternalReminderBlocks(value);
    summary.preview = previewValue.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
  }
  return summary;
}

export function debugReasoningStream(event: Record<string, unknown>): void {
  if (!DEBUG_PATH) return;
  try {
    mkdirSync(dirname(DEBUG_PATH), { recursive: true });
    appendFileSync(
      DEBUG_PATH,
      JSON.stringify({ t: Date.now(), seq: ++sequence, ...event }) + "\n",
      "utf-8",
    );
  } catch {
    // Debug logging must never affect an agent run.
  }
}
