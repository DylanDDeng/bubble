/**
 * PTY e2e: production starts directly in alternate-screen mode.
 *
 * Verifies the alt-screen transition precedes the first product frame, the
 * composer stays interactive, and Escape does not bounce through main-screen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTui, type PtySession } from "./pty-harness.js";
import { mkdirSync } from "node:fs";

mkdirSync(new URL("../../../.e2e-tmp/bubble-home", import.meta.url).pathname, { recursive: true });

describe.skipIf(process.env.BUBBLE_SKIP_PTY_E2E === "1")("pi-tui fullscreen e2e", () => {
  let session: PtySession | null = null;

  beforeAll(async () => {
    session = await startTui({ cols: 100, rows: 30 });
    await session!.waitFor("\x1b[?1049h", 15_000);
  }, 25_000);

  afterAll(() => {
    session?.kill();
  });

  it("enters fullscreen before rendering the first product frame", async () => {
    await session!.waitForViewport("I am a cat", 10_000);
    const viewport = session!.viewport().join("\n");
    expect(viewport).toContain("│ >");
    expect(viewport).toContain("┌");
    expect(viewport).toContain("└");
    const output = session!.output();
    const altScreenEntry = output.indexOf("\x1b[?1049h");
    expect(altScreenEntry).toBeGreaterThanOrEqual(0);
    expect(output.slice(0, altScreenEntry)).not.toContain("I am a cat");
  }, 20_000);

  it("accepts typed input inside fullscreen", async () => {
    session!.write("hello from fullscreen");
    await session!.waitFor("hello from fullscreen", 5_000);
  }, 15_000);

  it("stays in fullscreen and remains editable after Escape", async () => {
    session!.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session!.output()).not.toContain("\x1b[?1049l");
    session!.write("still fullscreen");
    await session!.waitForViewport("still fullscreen", 5_000);
  }, 20_000);

  it("restores the terminal without reprinting the fullscreen composer", async () => {
    session!.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 100));
    session!.write("\x03");
    await session!.waitFor("\x1b[?1049l", 8_000);
    await session!.waitFor("Duration", 8_000);

    const output = session!.output();
    const exitIndex = output.lastIndexOf("\x1b[?1049l");
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(output.slice(exitIndex)).not.toContain("\x1b[2K");
  }, 20_000);
});
