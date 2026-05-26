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

const execFileAsync = promisify(execFile);

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

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

export function isImageFilePath(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (!IMAGE_EXT.test(s)) return false;
  // Require an absolute or home-relative path. Pasted arbitrary text shouldn't
  // be treated as a path.
  return path.isAbsolute(s) || s.startsWith("~") || /^[A-Za-z]:\\/.test(s);
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
  const raw = await getImageFromClipboard();
  if (!raw) return { error: "clipboard has no image" };
  const sized = await maybeResizeImage(raw);
  const validation = validateImageSize(sized);
  if (!validation.ok) return { error: validation.reason };
  return { attachment: sized };
}
