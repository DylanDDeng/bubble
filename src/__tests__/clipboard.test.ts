import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process so tests never actually shell out to pbcopy/clip/etc.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
    unref: vi.fn(),
  })),
}));

import { copyToClipboard, encodeOsc52 } from "../clipboard.js";

describe("encodeOsc52", () => {
  it("emits the correct OSC 52 format for a known string", () => {
    // "hello" -> base64 "aGVsbG8="
    const sequence = encodeOsc52("hello");
    expect(sequence).toBe("\x1b]52;c;aGVsbG8=\x07");
  });

  it("encodes base64 correctly for a known multi-byte string", () => {
    const text = "Bubble ✨"; // includes a non-ASCII codepoint
    const expectedBase64 = Buffer.from(text).toString("base64");
    expect(encodeOsc52(text)).toBe(`\x1b]52;c;${expectedBase64}\x07`);
  });

  it("returns null when the base64 payload exceeds the ~100k cap", () => {
    // base64 grows ~4/3 vs input, so 80k input -> >100k base64 chars.
    const oversized = "a".repeat(80_000);
    expect(Buffer.from(oversized).toString("base64").length).toBeGreaterThan(100_000);
    expect(encodeOsc52(oversized)).toBeNull();
  });
});

describe("copyToClipboard OSC 52 emission", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  it("emits OSC 52 when running under tmux (additive to native copy)", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
    delete process.env.MOSH_CONNECTION;

    await copyToClipboard("hi");

    const osc52Writes = writeSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("\x1b]52;c;"),
    );
    expect(osc52Writes).toHaveLength(1);
    expect(osc52Writes[0]![0]).toBe(encodeOsc52("hi"));
  });

  it("does NOT emit OSC 52 for oversized text even under tmux", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const oversized = "a".repeat(80_000);

    // Oversized payload can't be emitted via OSC 52; native copy is still
    // expected to have succeeded on the test host, so no throw.
    await copyToClipboard(oversized);

    const osc52Writes = writeSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("\x1b]52;c;"),
    );
    expect(osc52Writes).toHaveLength(0);
  });
});
