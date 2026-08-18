/**
 * Image paste utilities: path detection, file reading, clipboard access, and size-capping.
 *
 * Terminals don't forward image bytes to stdin. Paths arrive as text when users
 * drag files in; Cmd+V of an image produces an empty paste (we probe the
 * clipboard). macOS screenshot shortcut (Cmd+Shift+Ctrl+4) writes to both a
 * TemporaryItems path and the clipboard — the path often gets cleaned up before
 * we can read it, so we fall back to the clipboard.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ContentPart } from "../../types.js";

const execFileAsync = promisify(execFile);

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_EXT_SOURCE = String.raw`(?:png|jpe?g|gif|webp|bmp)`;

// Anthropic/OpenAI image uploads cap at ~5MB base64. We target a bit below so
// the base64 inflation (4/3) doesn't push us over.
const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const RESIZE_TRIGGER_BYTES = Math.floor(MAX_BASE64_BYTES * 0.95);
// Target max dimension for auto-resize.
const RESIZE_MAX_DIM = 2048;

export interface ImageAttachment {
  base64: string;
  mediaType: string;
  /** Raw byte size of the decoded image (not base64). */
  bytes: number;
  /** data:<mediaType>;base64,<...> — ready to send as image_url.url. */
  dataUrl: string;
  filename?: string;
  sourcePath?: string;
}

export interface ImagePathToken {
  rawPath: string;
  start: number;
  end: number;
}

export interface ImageInputResolution {
  actualInput: string | ContentPart[];
  displayInput: string;
  errors: string[];
  attachments: ImageAttachment[];
  imagePathCount: number;
}

export interface LabeledImageAttachment extends ImageAttachment {
  label: string;
}

export interface ComposerImageResolution {
  text: string;
  attachments: LabeledImageAttachment[];
  errors: string[];
  imagePathCount: number;
  nextLabelIndex: number;
}

export function isImageFilePath(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (!IMAGE_EXT.test(s)) return false;
  // Require an absolute or home-relative path. Pasted arbitrary text shouldn't
  // be treated as a path.
  return path.isAbsolute(s) || s.startsWith("~") || /^[A-Za-z]:\\/.test(s);
}

export function extractImagePathTokens(input: string): ImagePathToken[] {
  const pattern = new RegExp(
    String.raw`(^|\s)(?:"([^"]+\.${IMAGE_EXT_SOURCE})"|'([^']+\.${IMAGE_EXT_SOURCE})'|((?:~|\/|[A-Za-z]:\\)(?:\\ |[^\s"'<>])+\.${IMAGE_EXT_SOURCE}))(?=$|\s)`,
    "gi",
  );
  const tokens: ImagePathToken[] = [];
  for (const match of input.matchAll(pattern)) {
    const leading = match[1] ?? "";
    const rawPath = match[2] ?? match[3] ?? match[4];
    if (!rawPath || !isImageFilePath(rawPath)) continue;
    const start = (match.index ?? 0) + leading.length;
    const end = (match.index ?? 0) + match[0].length;
    tokens.push({ rawPath, start, end });
  }
  return tokens;
}

export function removeImagePathTokens(input: string, tokens: ImagePathToken[]): string {
  if (tokens.length === 0) return input.trim();
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += input.slice(cursor, token.start);
    out += " ";
    cursor = token.end;
  }
  out += input.slice(cursor);
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function imageAttachmentLabel(att: ImageAttachment, index: number): string {
  return `image#${index}${imageExtension(att)}`;
}

/**
 * Label for an image path before ingestion runs. Matches what
 * imageAttachmentLabel produces for the same file, so a label inserted at
 * paste time stays a valid key once the attachment is registered.
 */
export function imageLabelForPath(rawPath: string, index: number): string {
  const ext = path.extname(unescapeShell(rawPath.trim())).toLowerCase() || ".png";
  return `image#${index}${ext}`;
}

export function imageAttachmentReference(att: ImageAttachment, index: number): string {
  return `[${imageAttachmentLabel(att, index)}]`;
}

export function imageAttachmentLabelPattern(): RegExp {
  return /\[image#(\d+)\.[^\]\s]+\]/g;
}

function defaultImagePrompt(count: number): string {
  return count === 1
    ? "Please analyze the attached image."
    : "Please analyze the attached images.";
}

function imageExtension(att: ImageAttachment): string {
  const fromPath = path.extname(att.filename ?? att.sourcePath ?? "").toLowerCase();
  if (fromPath) return fromPath;
  if (att.mediaType === "image/jpeg") return ".jpg";
  if (att.mediaType === "image/webp") return ".webp";
  if (att.mediaType === "image/gif") return ".gif";
  if (att.mediaType === "image/bmp") return ".bmp";
  return ".png";
}

export function buildImageContentParts(promptText: string, attachments: ImageAttachment[]): ContentPart[] {
  const text = promptText.trim() || defaultImagePrompt(attachments.length);
  return [
    { type: "text", text },
    ...attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.dataUrl },
    })),
  ];
}

export function formatImageDisplayInput(promptText: string, attachments: ImageAttachment[], labelStart = 1): string {
  const text = promptText.trim() || defaultImagePrompt(attachments.length);
  const imageLines = attachments.map((attachment, index) => imageAttachmentReference(attachment, labelStart + index));
  return `${text}\n${imageLines.join("\n")}`;
}

export function buildImageContentPartsFromLabels(
  input: string,
  attachmentsByLabel: Map<string, ImageAttachment>,
): { actualInput?: ContentPart[]; displayInput: string; usedLabels: string[] } {
  const matches = Array.from(input.matchAll(imageAttachmentLabelPattern()));
  const usedLabels: string[] = [];
  const parts: ContentPart[] = [];
  let cursor = 0;

  for (const match of matches) {
    const label = match[0].slice(1, -1);
    const attachment = attachmentsByLabel.get(label);
    if (!attachment) continue;

    const start = match.index ?? 0;
    const before = input.slice(cursor, start).trim();
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    usedLabels.push(label);
    cursor = start + match[0].length;
  }
  if (usedLabels.length === 0) return { displayInput: input, usedLabels: [] };

  const rest = input.slice(cursor).trim();
  if (rest) parts.push({ type: "text", text: rest });
  if (!parts.some((part) => part.type === "text")) {
    parts.unshift({ type: "text", text: defaultImagePrompt(usedLabels.length) });
  }

  return {
    actualInput: parts,
    displayInput: input.trim() || usedLabels.map((label) => `[${label}]`).join("\n"),
    usedLabels,
  };
}

/**
 * Split a pasted blob into candidate path tokens.
 *
 * Multi-drag from Finder delivers a mix of newline- and space-separated
 * absolute paths. Spaces inside a single path are escaped (`\ `) — we split
 * only on a space that is followed by the start of a new absolute path.
 */
export function splitPastedPaths(pasted: string): string[] {
  const out: string[] = [];
  for (const line of pasted.split(/\r?\n/)) {
    for (const piece of line.split(/ (?=\/|[A-Za-z]:\\)/)) {
      const t = piece.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * True when a pasted blob consists solely of image file paths (drag from
 * Finder, or a terminal that converts clipboard images to temp-file paths).
 */
export function isImagePathPaste(pasted: string): boolean {
  const pieces = splitPastedPaths(pasted);
  return pieces.length > 0 && pieces.every((piece) => isImageFilePath(piece));
}

/**
 * Bare image filename with no directory, e.g. "Screenshot ... AM.png".
 * Copying an image file in Finder puts only the file's NAME in the
 * clipboard's plain-text flavor — the actual bits arrive as a file-url or
 * image flavor that must be read from the clipboard separately.
 */
export function bareImageFilenameFromPaste(pasted: string): string | null {
  const s = pasted.trim();
  if (!s || s.length > 255) return null;
  if (/[\n\r/\\]/.test(s)) return null;
  if (!IMAGE_EXT.test(s)) return null;
  return s;
}

function mediaTypeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function resolveHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function unescapeShell(p: string): string {
  return p.replace(/\\ /g, " ");
}

function attachmentFromBuffer(
  buffer: Buffer,
  mediaType: string,
  meta: { filename?: string; sourcePath?: string } = {},
): ImageAttachment {
  const base64 = buffer.toString("base64");
  return {
    base64,
    mediaType,
    bytes: buffer.length,
    dataUrl: `data:${mediaType};base64,${base64}`,
    filename: meta.filename,
    sourcePath: meta.sourcePath,
  };
}

export async function readImageFromPath(rawPath: string): Promise<ImageAttachment | null> {
  const resolved = resolveHome(unescapeShell(rawPath.trim()));
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return null;
    const buffer = await fs.readFile(resolved);
    return attachmentFromBuffer(buffer, mediaTypeFromExt(resolved), {
      filename: path.basename(resolved),
      sourcePath: resolved,
    });
  } catch {
    return null;
  }
}

/** macOS screenshot shortcut writes to these paths and they may be auto-cleaned. */
export function isScreenshotTempPath(s: string): boolean {
  return /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(s);
}

export async function getImageFromClipboard(): Promise<ImageAttachment | null> {
  switch (process.platform) {
    case "darwin":
      return getClipboardImageDarwin();
    case "linux":
      return getClipboardImageLinux();
    case "win32":
      return getClipboardImageWindows();
    default:
      return null;
  }
}

async function getClipboardImageDarwin(): Promise<ImageAttachment | null> {
  // Probe first — `as «class PNGf»` throws if clipboard has no image.
  try {
    await execFileAsync("osascript", ["-e", "the clipboard as «class PNGf»"], {
      timeout: 5000,
    });
  } catch {
    return null;
  }
  const tmp = path.join(os.tmpdir(), `bubble_clip_${Date.now()}_${process.pid}.png`);
  const script =
    `set png_data to (the clipboard as «class PNGf»)\n` +
    `set fp to open for access POSIX file "${tmp}" with write permission\n` +
    `write png_data to fp\n` +
    `close access fp`;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
    const buf = await fs.readFile(tmp);
    return attachmentFromBuffer(buf, "image/png");
  } catch {
    return null;
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function getClipboardImageLinux(): Promise<ImageAttachment | null> {
  const candidates: Array<[string, string[]]> = [
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ["wl-paste", ["--type", "image/png"]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      // encoding: "buffer" makes stdout a Buffer instead of a string so PNG
      // bytes survive without UTF-8 mangling.
      const result = await execFileAsync(cmd, args, {
        timeout: 5000,
        encoding: "buffer",
      } as any);
      const buf = result.stdout as unknown as Buffer;
      if (buf && buf.length > 0) {
        return attachmentFromBuffer(buf, "image/png");
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function getClipboardImageWindows(): Promise<ImageAttachment | null> {
  const tmp = path.join(os.tmpdir(), `bubble_clip_${Date.now()}_${process.pid}.png`);
  const tmpPs = tmp.replace(/\\/g, "\\\\");
  const script =
    `Add-Type -AssemblyName System.Drawing; ` +
    `$img = Get-Clipboard -Format Image; ` +
    `if ($img) { $img.Save('${tmpPs}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'OK' } ` +
    `else { Write-Output 'NONE' }`;
  try {
    const result = await execFileAsync(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: 5000 },
    );
    if (!String(result.stdout).includes("OK")) return null;
    const buf = await fs.readFile(tmp);
    return attachmentFromBuffer(buf, "image/png");
  } catch {
    return null;
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function which(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd], {
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * If the image is close to the API size cap, try to downscale it in place.
 * Uses the OS-native tools that are typically available:
 *   - macOS: `sips` (always present)
 *   - linux: ImageMagick `convert` (if installed)
 * Returns the original attachment if resize isn't needed or can't run.
 */
export async function maybeResizeImage(att: ImageAttachment): Promise<ImageAttachment> {
  if (att.base64.length < RESIZE_TRIGGER_BYTES) return att;

  const tmpDir = os.tmpdir();
  const stamp = `${Date.now()}_${process.pid}`;
  const inExt = path.extname(att.filename ?? att.sourcePath ?? `.png`).toLowerCase() || ".png";
  const tmpIn = path.join(tmpDir, `bubble_img_in_${stamp}${inExt}`);
  const tmpOut = path.join(tmpDir, `bubble_img_out_${stamp}.jpg`);

  try {
    await fs.writeFile(tmpIn, Buffer.from(att.base64, "base64"));

    let ok = false;
    if (process.platform === "darwin") {
      try {
        await execFileAsync(
          "sips",
          ["-Z", String(RESIZE_MAX_DIM), "-s", "format", "jpeg", "-s", "formatOptions", "80", tmpIn, "--out", tmpOut],
          { timeout: 10000 },
        );
        ok = true;
      } catch {
        ok = false;
      }
    } else if (await which("convert")) {
      try {
        await execFileAsync(
          "convert",
          [tmpIn, "-resize", `${RESIZE_MAX_DIM}x${RESIZE_MAX_DIM}>`, "-quality", "80", tmpOut],
          { timeout: 10000 },
        );
        ok = true;
      } catch {
        ok = false;
      }
    }

    if (!ok) return att;
    const resized = await fs.readFile(tmpOut);
    if (resized.length >= att.bytes) return att;
    return attachmentFromBuffer(resized, "image/jpeg", {
      filename: att.filename,
      sourcePath: att.sourcePath,
    });
  } catch {
    return att;
  } finally {
    await fs.unlink(tmpIn).catch(() => undefined);
    await fs.unlink(tmpOut).catch(() => undefined);
  }
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateImageSize(att: ImageAttachment): ValidationResult {
  if (att.base64.length > MAX_BASE64_BYTES) {
    const kb = Math.round(att.base64.length / 1024);
    const max = Math.round(MAX_BASE64_BYTES / 1024);
    const hint =
      process.platform === "darwin"
        ? " (install/confirm `sips` on PATH to auto-resize)"
        : process.platform === "linux"
          ? " (install ImageMagick `convert` to auto-resize)"
          : "";
    return {
      ok: false,
      reason: `image base64 is ${kb}KB, exceeds ${max}KB API cap${hint}`,
    };
  }
  return { ok: true };
}

/** End-to-end: given a file path, read -> resize-if-needed -> validate. */
export async function ingestImagePath(p: string): Promise<{ attachment?: ImageAttachment; error?: string }> {
  const raw = await readImageFromPath(p);
  if (!raw) return { error: `cannot read image at ${p}` };
  const sized = await maybeResizeImage(raw);
  const validation = validateImageSize(sized);
  if (!validation.ok) return { error: validation.reason };
  return { attachment: sized };
}

export async function ingestClipboardImage(): Promise<{ attachment?: ImageAttachment; error?: string }> {
  // A file reference wins over bitmap flavors: for a copied FILE, coercing
  // the clipboard to PNGf yields the file's generic ICON, not the image.
  const filePath = await getClipboardFilePath();
  if (filePath) {
    if (isImageFilePath(filePath)) return ingestImagePath(filePath);
    return { error: `clipboard file is not an image: ${filePath}` };
  }
  const raw = await getImageFromClipboard();
  if (!raw) return { error: "clipboard has no image" };
  const sized = await maybeResizeImage(raw);
  const validation = validateImageSize(sized);
  if (!validation.ok) return { error: validation.reason };
  return { attachment: sized };
}

async function getClipboardFilePath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    // Probe first — AppleScript happily coerces plain TEXT into a file URL,
    // so only trust «class furl» when the clipboard really carries one.
    const probe = await execFileAsync("osascript", ["-e", "clipboard info for «class furl»"], {
      timeout: 5000,
    });
    if (!String(probe.stdout).includes("furl")) return null;
    const result = await execFileAsync(
      "osascript",
      ["-e", "POSIX path of (the clipboard as «class furl»)"],
      { timeout: 5000 },
    );
    const p = String(result.stdout).trim();
    return p || null;
  } catch {
    return null;
  }
}

export async function resolveImageInput(input: string, options: { labelStart?: number } = {}): Promise<ImageInputResolution> {
  const tokens = extractImagePathTokens(input);
  if (tokens.length === 0) {
    return {
      actualInput: input,
      displayInput: input,
      errors: [],
      attachments: [],
      imagePathCount: 0,
    };
  }

  const attachments: ImageAttachment[] = [];
  const errors: string[] = [];
  const attachmentsByToken = new Map<ImagePathToken, { attachment: ImageAttachment; label: string }>();
  let nextLabelIndex = options.labelStart ?? 1;
  for (const token of tokens) {
    const result = await ingestImagePath(token.rawPath);
    if (result.attachment) {
      attachments.push(result.attachment);
      attachmentsByToken.set(token, {
        attachment: result.attachment,
        label: imageAttachmentLabel(result.attachment, nextLabelIndex++),
      });
    } else {
      errors.push(`${token.rawPath}: ${result.error ?? "could not attach image"}`);
    }
  }

  if (attachments.length === 0) {
    return {
      actualInput: input,
      displayInput: input,
      errors,
      attachments: [],
      imagePathCount: tokens.length,
    };
  }

  const parts: ContentPart[] = [];
  let displayInput = "";
  let cursor = 0;
  for (const token of tokens) {
    const entry = attachmentsByToken.get(token);
    if (!entry) continue;
    const before = input.slice(cursor, token.start);
    displayInput += before;
    const text = before.trim();
    if (text) parts.push({ type: "text", text });
    parts.push({ type: "image_url", image_url: { url: entry.attachment.dataUrl } });
    displayInput += `[${entry.label}]`;
    cursor = token.end;
  }
  const rest = input.slice(cursor);
  displayInput += rest;
  const restText = rest.trim();
  if (restText) parts.push({ type: "text", text: restText });
  if (!parts.some((part) => part.type === "text")) {
    parts.unshift({ type: "text", text: defaultImagePrompt(attachments.length) });
  }

  return {
    actualInput: parts,
    displayInput: displayInput.trim(),
    errors,
    attachments,
    imagePathCount: tokens.length,
  };
}

export async function resolveComposerImagePaths(
  input: string,
  options: { labelStart?: number } = {},
): Promise<ComposerImageResolution> {
  const tokens = extractImagePathTokens(input);
  let nextLabelIndex = options.labelStart ?? 1;
  if (tokens.length === 0) {
    return {
      text: input,
      attachments: [],
      errors: [],
      imagePathCount: 0,
      nextLabelIndex,
    };
  }

  const errors: string[] = [];
  const attachments: LabeledImageAttachment[] = [];
  const replacements = new Map<ImagePathToken, string>();
  for (const token of tokens) {
    const result = await ingestImagePath(token.rawPath);
    if (!result.attachment) {
      errors.push(`${token.rawPath}: ${result.error ?? "could not attach image"}`);
      continue;
    }
    const label = imageAttachmentLabel(result.attachment, nextLabelIndex++);
    attachments.push({ ...result.attachment, label });
    replacements.set(token, `[${label}]`);
  }

  let text = "";
  let cursor = 0;
  for (const token of tokens) {
    text += input.slice(cursor, token.start);
    text += replacements.get(token) ?? input.slice(token.start, token.end);
    cursor = token.end;
  }
  text += input.slice(cursor);

  return {
    text,
    attachments,
    errors,
    imagePathCount: tokens.length,
    nextLabelIndex,
  };
}
