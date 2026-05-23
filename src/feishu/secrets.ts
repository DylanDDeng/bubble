/**
 * AES-256-GCM keystore for the Feishu App Secret.
 *
 * Key derivation: scrypt(machineId + home, salt) → 32-byte key.
 * Salt is stored alongside ciphertext (it's the keystore record itself
 * that's the secret — salt being public is fine, that's its job).
 *
 * File format (JSON, 0600 perms):
 *   { "v": 1, "iv": "...", "tag": "...", "salt": "...", "ciphertext": "..." }
 * All blobs base64-encoded.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";

const FILE_VERSION = 1;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const SCRYPT_N = 1 << 14;

export interface KeystoreFile {
  v: number;
  iv: string;
  tag: string;
  salt: string;
  ciphertext: string;
}

export class KeystoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "KeystoreError";
  }
}

function deriveKey(salt: Buffer): Buffer {
  const material = `${hostname()}::${homedir()}`;
  return scryptSync(material, salt, KEY_LENGTH, { N: SCRYPT_N });
}

export function encryptSecret(plaintext: string): KeystoreFile {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: FILE_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    salt: salt.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

export function decryptSecret(record: KeystoreFile): string {
  if (record.v !== FILE_VERSION) {
    throw new KeystoreError(`Unsupported keystore version: ${record.v}`);
  }
  const salt = Buffer.from(record.salt, "base64");
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const ciphertext = Buffer.from(record.ciphertext, "base64");
  if (salt.length !== SALT_LENGTH) throw new KeystoreError("Invalid salt length");
  if (iv.length !== IV_LENGTH) throw new KeystoreError("Invalid iv length");
  if (tag.length !== TAG_LENGTH) throw new KeystoreError("Invalid tag length");
  const key = deriveKey(salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    throw new KeystoreError("Failed to decrypt: machine identity changed, file corrupted, or wrong key", err);
  }
}

export function saveKeystoreFile(path: string, record: KeystoreFile): void {
  writeFileSync(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems (Windows, certain Linux mounts) reject chmod; not fatal.
  }
}

export function loadKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new KeystoreError(`Keystore file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new KeystoreError(`Failed to read keystore: ${path}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new KeystoreError("Keystore file is not valid JSON", err);
  }
  if (!isKeystoreFile(parsed)) {
    throw new KeystoreError("Keystore file has unexpected shape");
  }
  return parsed;
}

function isKeystoreFile(value: unknown): value is KeystoreFile {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.salt === "string" &&
    typeof obj.ciphertext === "string"
  );
}

/**
 * Encrypt-and-verify: encrypts the plaintext, then immediately decrypts it
 * to confirm the keystore works on this machine. Throws on round-trip
 * failure. Returns a stable check string callers may persist alongside
 * config (e.g. `encryptCheck` field) so subsequent startups can sanity-check
 * without round-tripping the full secret on every boot.
 */
export function encryptWithSelfCheck(plaintext: string): { record: KeystoreFile; check: string } {
  const record = encryptSecret(plaintext);
  const back = decryptSecret(record);
  if (back !== plaintext) {
    throw new KeystoreError("Self-check failed: decrypt did not match original");
  }
  return { record, check: record.tag.slice(0, 8) };
}
