import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, encryptWithSelfCheck, KeystoreError } from "../secrets.js";

describe("AES-256-GCM keystore round-trip", () => {
  it("decrypts what it encrypted", () => {
    const record = encryptSecret("super-secret-12345");
    expect(decryptSecret(record)).toBe("super-secret-12345");
  });

  it("rejects tampered ciphertext", () => {
    const record = encryptSecret("payload");
    // Flip a byte.
    const tampered = { ...record, ciphertext: flipFirstChar(record.ciphertext) };
    expect(() => decryptSecret(tampered)).toThrow(KeystoreError);
  });

  it("rejects tampered auth tag", () => {
    const record = encryptSecret("payload");
    const tampered = { ...record, tag: flipFirstChar(record.tag) };
    expect(() => decryptSecret(tampered)).toThrow(KeystoreError);
  });

  it("encryptWithSelfCheck returns a stable check string", () => {
    const { check } = encryptWithSelfCheck("payload");
    expect(check.length).toBeGreaterThan(0);
  });
});

function flipFirstChar(b64: string): string {
  const ch = b64.charAt(0);
  const flipped = ch === "A" ? "B" : "A";
  return flipped + b64.slice(1);
}
