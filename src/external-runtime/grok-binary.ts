import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ExternalRuntimeBinaryInfo } from "./types.js";
import { GrokRuntimeError } from "./grok-errors.js";

export const GROK_PINNED_VERSION = "0.2.93";
export const GROK_PINNED_SHA256 = "2a97ba675bd992aa9b981e2e83776460d94f469b510c0b8efe28b50d236d767c";

export interface GrokBinaryDependencies {
  platform?: NodeJS.Platform;
  arch?: string;
  uid?: number;
  binaryPath?: string;
  pathEnv?: string;
  userHome?: string;
  expectedVersion?: string;
  expectedSha256?: string;
  hashFile?: (path: string) => Promise<string>;
  readVersion?: (path: string) => Promise<string>;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveGrokBinary(deps: GrokBinaryDependencies = {}): Promise<string> {
  const candidates: string[] = [];
  if (deps.binaryPath) candidates.push(deps.binaryPath);
  if (!deps.binaryPath) {
    const home = deps.userHome ?? homedir();
    candidates.push(join(home, ".local", "bin", "grok"), join(home, ".grok", "bin", "grok"));
    for (const entry of (deps.pathEnv ?? process.env.PATH ?? "").split(delimiter)) {
      if (entry && isAbsolute(entry)) candidates.push(join(entry, "grok"));
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!isAbsolute(candidate) || !(await isExecutable(candidate))) continue;
    try {
      return await realpath(candidate);
    } catch {
      // Continue to the next independently verified candidate.
    }
  }
  throw new GrokRuntimeError("binary_not_found", "Install the pinned Grok Build CLI (0.2.93) to use Grok subscription login.");
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * The executable's directory chain is part of the trust boundary. Even a
 * read-only, user-owned file can be swapped between verification and spawn if
 * another local user can rename a writable ancestor directory entry.
 */
export async function verifyGrokBinaryAncestors(
  path: string,
  uid = process.getuid?.(),
): Promise<void> {
  if (uid === undefined) {
    throw new GrokRuntimeError("binary_untrusted", "The Grok CLI path owner could not be verified.");
  }
  let current = dirname(path);
  while (true) {
    const metadata = await stat(current);
    if (!metadata.isDirectory() || (metadata.uid !== uid && metadata.uid !== 0) || (metadata.mode & 0o022) !== 0) {
      throw new GrokRuntimeError(
        "binary_untrusted",
        "The Grok CLI must be located under directories writable only by the current user or root.",
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function parseGrokVersion(output: string): string | undefined {
  return /^grok\s+(\d+\.\d+\.\d+)(?:\s|$)/m.exec(output.trim())?.[1];
}

export async function verifyGrokBinary(deps: GrokBinaryDependencies = {}): Promise<ExternalRuntimeBinaryInfo> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new GrokRuntimeError("unsupported_platform", "Grok Subscription is available on macOS Apple Silicon only.");
  }

  const path = await resolveGrokBinary(deps);
  const metadata = await stat(path);
  const uid = deps.uid ?? process.getuid?.();
  if (!metadata.isFile() || uid === undefined || metadata.uid !== uid) {
    throw new GrokRuntimeError("binary_untrusted", "The Grok CLI must be a regular file owned by the current user.");
  }
  if ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
    throw new GrokRuntimeError("binary_untrusted", "The Grok CLI must be executable and not writable by group or other users.");
  }
  await verifyGrokBinaryAncestors(path, uid);

  // Never execute an untrusted candidate merely to ask it for its version.
  const sha256 = await (deps.hashFile ?? sha256File)(path);
  const expectedSha256 = deps.expectedSha256 ?? GROK_PINNED_SHA256;
  if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new GrokRuntimeError("binary_hash_mismatch", "The Grok CLI checksum does not match Bubble's pinned build.");
  }

  const expectedVersion = deps.expectedVersion ?? GROK_PINNED_VERSION;
  const output = await deps.readVersion?.(path);
  if (output === undefined) {
    throw new GrokRuntimeError("protocol_error", "A version reader is required to verify the Grok CLI.");
  }
  const version = parseGrokVersion(output);
  if (version !== expectedVersion) {
    throw new GrokRuntimeError("binary_version_mismatch", `Grok CLI ${expectedVersion} is required.`);
  }
  return { path, version, sha256: sha256.toLowerCase() };
}
