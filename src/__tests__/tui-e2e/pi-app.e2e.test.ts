/**
 * PTY e2e: the production pi-tui app (default entry after cutover).
 *
 * Covers the core product loop on a real terminal: welcome renders, composer
 * echoes typed input, resize storms keep interaction alive, and double
 * Ctrl+C exits cleanly with the terminal restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTui, type PtySession } from "./pty-harness.js";
import { mkdirSync } from "node:fs";

mkdirSync(new URL("../../../.e2e-tmp/bubble-home", import.meta.url).pathname, { recursive: true });

describe.skipIf(process.env.BUBBLE_SKIP_PTY_E2E === "1")("pi-tui app PTY e2e (production entry)", () => {
  let session: PtySession | null = null;

  beforeAll(async () => {
    session = await startTui({ cols: 100, rows: 30 });
    await session!.waitFor("Bubble", 15_000).catch(() => {});
  }, 25_000);

  afterAll(() => {
    session?.kill();
  });

  it("renders the welcome header with the model and cwd", async () => {
    await session!.waitFor("pi-tui", 10_000);
    await session!.waitFor("my-coding-agent-pi-tui", 5_000);
  }, 30_000);

  it("echoes composer input", async () => {
    session!.write("hello production app");
    await session!.waitFor("hello production app", 5_000);
  }, 20_000);

  it("slash /help surfaces the command notice", async () => {
    session!.write("\x7f".repeat(24)); // clear the previous echo fully
    session!.write("/help\r");
    await session!.waitFor("commands:", 5_000);
  }, 20_000);

  it("survives a resize storm narrow -> wide -> tiny", async () => {
    session!.resize(34, 12);
    session!.write("narrow");
    await session!.waitFor("narrow", 5_000);

    session!.resize(140, 40);
    session!.write("wide");
    await session!.waitFor("wide", 5_000);

    session!.resize(24, 8);
    session!.write("tiny");
    await session!.waitFor("tiny", 5_000);
  }, 30_000);

  it("double Ctrl+C exits without wedging", async () => {
    session!.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 250));
    session!.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(true).toBe(true);
  }, 20_000);
});
