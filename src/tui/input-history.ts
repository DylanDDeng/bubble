import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

const MAX_HISTORY_ENTRIES = 1000;

export interface HistoryScope {
  sessionFile?: string | null;
  cwd?: string | null;
}

export interface HistoryLoadOptions {
  filePath?: string;
  scope?: HistoryScope;
  includeLegacy?: boolean;
}

export interface HistoryAppendOptions {
  filePath?: string;
  scope?: HistoryScope;
  createdAt?: Date | string;
}

export interface HistoryImageAttachment {
  mediaType: string;
  bytes: number;
  dataUrl: string;
  base64: string;
  filename?: string;
  sourcePath?: string;
}

export interface HistoryEntry {
  text: string;
  images: HistoryImageAttachment[];
  imageDisplayStart?: number;
}

interface ParsedHistoryEntry {
  text: string;
  sessionFile?: string;
  cwd?: string;
  images: HistoryImageAttachment[];
  imageDisplayStart?: number;
}

export function defaultHistoryFilePath(): string {
  return join(getBubbleHome(), "input-history.jsonl");
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeScope(scope?: HistoryScope): { sessionFile?: string; cwd?: string } {
  return {
    sessionFile: nonEmpty(scope?.sessionFile),
    cwd: nonEmpty(scope?.cwd),
  };
}

function parseLoadOptions(arg?: string | HistoryLoadOptions): Required<Pick<HistoryLoadOptions, "filePath">> & Omit<HistoryLoadOptions, "filePath"> {
  if (typeof arg === "string") return { filePath: arg };
  return { filePath: arg?.filePath ?? defaultHistoryFilePath(), scope: arg?.scope, includeLegacy: arg?.includeLegacy };
}

function parseAppendOptions(arg?: string | HistoryAppendOptions): Required<Pick<HistoryAppendOptions, "filePath">> & Omit<HistoryAppendOptions, "filePath"> {
  if (typeof arg === "string") return { filePath: arg };
  return { filePath: arg?.filePath ?? defaultHistoryFilePath(), scope: arg?.scope, createdAt: arg?.createdAt };
}

function base64FromDataUrl(dataUrl: string): string {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  return index >= 0 ? dataUrl.slice(index + marker.length) : "";
}

function normalizeHistoryImage(input: unknown): HistoryImageAttachment | null {
  if (!input || typeof input !== "object") return null;
  const image = input as Record<string, unknown>;
  const mediaType = typeof image.mediaType === "string" ? image.mediaType : "";
  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : "";
  const bytes = typeof image.bytes === "number" && Number.isFinite(image.bytes) ? image.bytes : 0;
  if (!mediaType || !dataUrl || bytes <= 0) return null;
  const base64 = typeof image.base64 === "string" && image.base64
    ? image.base64
    : base64FromDataUrl(dataUrl);
  if (!base64) return null;
  return {
    mediaType,
    bytes,
    dataUrl,
    base64,
    ...(typeof image.filename === "string" && image.filename ? { filename: image.filename } : {}),
    ...(typeof image.sourcePath === "string" && image.sourcePath ? { sourcePath: image.sourcePath } : {}),
  };
}

function normalizeHistoryImages(input: unknown): HistoryImageAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((image) => {
    const normalized = normalizeHistoryImage(image);
    return normalized ? [normalized] : [];
  });
}

function normalizeImageDisplayStart(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input > 0
    ? Math.floor(input)
    : undefined;
}

function toHistoryEntry(input: string | HistoryEntry): HistoryEntry | null {
  if (typeof input === "string") {
    return input.trim().length > 0 ? { text: input, images: [] } : null;
  }
  const text = typeof input.text === "string" ? input.text : "";
  const images = normalizeHistoryImages(input.images);
  const imageDisplayStart = normalizeImageDisplayStart(input.imageDisplayStart);
  if (text.trim().length === 0 && images.length === 0) return null;
  return {
    text,
    images,
    ...(imageDisplayStart !== undefined ? { imageDisplayStart } : {}),
  };
}

function historyEntrySignature(entry: string | HistoryEntry): string {
  const normalized = typeof entry === "string" ? { text: entry, images: [] } : entry;
  return JSON.stringify({
    text: normalized.text,
    images: normalizeHistoryImages(normalized.images).map((image) => ({
      mediaType: image.mediaType,
      bytes: image.bytes,
      dataUrl: image.dataUrl,
      filename: image.filename ?? "",
      sourcePath: image.sourcePath ?? "",
    })),
  });
}

function serializableHistoryImages(images: HistoryImageAttachment[]): Array<Omit<HistoryImageAttachment, "base64">> {
  return normalizeHistoryImages(images).map((image) => ({
    mediaType: image.mediaType,
    bytes: image.bytes,
    dataUrl: image.dataUrl,
    ...(image.filename ? { filename: image.filename } : {}),
    ...(image.sourcePath ? { sourcePath: image.sourcePath } : {}),
  }));
}

function parseHistoryLine(line: string): ParsedHistoryEntry | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "string") {
      return parsed.length > 0 ? { text: parsed, images: [] } : null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const images = normalizeHistoryImages(parsed.images);
    const imageDisplayStart = normalizeImageDisplayStart(parsed.imageDisplayStart);
    if (text.length === 0 && images.length === 0) return null;
    return {
      text,
      images,
      ...(imageDisplayStart !== undefined ? { imageDisplayStart } : {}),
      sessionFile: nonEmpty(parsed.sessionFile),
      cwd: nonEmpty(parsed.cwd),
    };
  } catch {
    return null;
  }
}

function historyEntryMatchesScope(
  entry: ParsedHistoryEntry,
  scope: HistoryScope | undefined,
  includeLegacy: boolean,
): boolean {
  const normalized = normalizeScope(scope);
  if (!scope) return true;
  if (!normalized.sessionFile) return includeLegacy && !entry.sessionFile;
  if (!entry.sessionFile) return includeLegacy;
  return entry.sessionFile === normalized.sessionFile;
}

// JSONL on disk: new entries are JSON objects with session metadata and optional
// image data. Older files used JSON strings; unscoped loads still read them,
// while scoped loads match only sessionFile so old global history cannot leak
// into a session.
export function loadHistoryEntriesSync(arg?: string | HistoryLoadOptions): HistoryEntry[] {
  const { filePath, scope, includeLegacy = false } = parseLoadOptions(arg);
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    const out: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const parsed = parseHistoryLine(line);
      if (!parsed) continue;
      if (historyEntryMatchesScope(parsed, scope, includeLegacy)) {
        out.push({
          text: parsed.text,
          images: parsed.images,
          ...(parsed.imageDisplayStart !== undefined ? { imageDisplayStart: parsed.imageDisplayStart } : {}),
        });
      }
    }
    return out.length > MAX_HISTORY_ENTRIES ? out.slice(-MAX_HISTORY_ENTRIES) : out;
  } catch {
    return [];
  }
}

export function loadHistorySync(arg?: string | HistoryLoadOptions): string[] {
  return loadHistoryEntriesSync(arg).map((entry) => entry.text);
}

export function appendHistoryEntry(entry: string | HistoryEntry, arg?: string | HistoryAppendOptions): void {
  const normalizedEntry = toHistoryEntry(entry);
  if (!normalizedEntry) return;
  const { filePath, scope, createdAt } = parseAppendOptions(arg);
  const normalizedScope = normalizeScope(scope);
  const timestamp = typeof createdAt === "string"
    ? createdAt
    : (createdAt ?? new Date()).toISOString();
  const record = {
    text: normalizedEntry.text,
    createdAt: timestamp,
    ...(normalizedEntry.images.length > 0 ? { images: serializableHistoryImages(normalizedEntry.images) } : {}),
    ...(normalizedEntry.imageDisplayStart !== undefined ? { imageDisplayStart: normalizedEntry.imageDisplayStart } : {}),
    ...(normalizedScope.sessionFile ? { sessionFile: normalizedScope.sessionFile } : {}),
    ...(normalizedScope.cwd ? { cwd: normalizedScope.cwd } : {}),
  };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Persistence is best-effort; never crash the composer over disk IO.
  }
}

export interface HistoryNavState {
  history: Array<string | HistoryEntry>;
  index: number | null;
  draft: string | HistoryEntry;
}

export interface HistoryNavResult {
  text: string;
  images?: HistoryImageAttachment[];
  imageDisplayStart?: number;
  index: number | null;
  draft: string | HistoryEntry;
  changed: boolean;
}

// Pure transition for up/down navigation. `index === null` means the user is
// editing a fresh draft; otherwise it points at history[index]. When stepping
// from the draft into history we snapshot the current text so down past the
// newest entry can restore it.
export function stepHistory(
  state: HistoryNavState,
  direction: "up" | "down",
  currentEntry: string | HistoryEntry,
): HistoryNavResult {
  const { history, index, draft } = state;
  const current = toHistoryEntry(currentEntry) ?? { text: "", images: [] };
  const currentDraft = typeof currentEntry === "string" ? currentEntry : current;
  const noChange: HistoryNavResult = { text: current.text, index, draft, changed: false };

  const resultFromEntry = (
    entry: string | HistoryEntry,
    nextIndex: number | null,
    nextDraft: string | HistoryEntry,
  ): HistoryNavResult => {
    const normalized = toHistoryEntry(entry) ?? { text: "", images: [] };
    return {
      text: normalized.text,
      ...(normalized.images.length > 0 ? { images: normalized.images } : {}),
      ...(normalized.imageDisplayStart !== undefined ? { imageDisplayStart: normalized.imageDisplayStart } : {}),
      index: nextIndex,
      draft: nextDraft,
      changed: true,
    };
  };

  if (direction === "up") {
    if (history.length === 0) return noChange;
    if (index === null) {
      const newIdx = history.length - 1;
      return resultFromEntry(history[newIdx], newIdx, currentDraft);
    }
    if (index > 0) {
      return resultFromEntry(history[index - 1], index - 1, draft);
    }
    return noChange;
  }

  if (index === null) return noChange;
  if (index < history.length - 1) {
    return resultFromEntry(history[index + 1], index + 1, draft);
  }
  return resultFromEntry(draft, null, "");
}

// Push to in-memory history with last-entry dedupe so repeated identical
// submissions don't spam the stack.
export function pushHistoryEntry(history: string[], entry: string): string[];
export function pushHistoryEntry(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[];
export function pushHistoryEntry(
  history: Array<string | HistoryEntry>,
  entry: string | HistoryEntry,
): Array<string | HistoryEntry> {
  const normalizedEntry = toHistoryEntry(entry);
  if (!normalizedEntry) return history;
  if (history.length > 0 && historyEntrySignature(history[history.length - 1]) === historyEntrySignature(normalizedEntry)) {
    return history;
  }
  if (typeof entry === "string" && history.every((item) => typeof item === "string")) {
    return [...history, normalizedEntry.text];
  }
  return [...history, entry];
}
