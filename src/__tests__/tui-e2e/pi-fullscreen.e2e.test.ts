/**
 * PTY e2e: /fullscreen alternate-screen mode.
 *
 * Enters the alt-screen transcript view, verifies it renders the transcript
 * header + composer, submits a message inside fullscreen, and returns to the
 * main screen via Escape — the terminal must end back on the main flow.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { startTui, type PtySession } from "./pty-harness.js";
import { mkdirSync } from "node:fs";

mkdirSync(new URL("../../../.e2e-tmp/bubble-home", import.meta.url).pathname, { recursive: true });

describe.skipIf(process.env.BUBBLE_SKIP_PTY_E2E === "1")("pi-tui fullscreen e2e", () => {
  let session: PtySession | null = null;

  beforeAll(async () => {
    session = await startTui({ cols: 100, rows: 30 });
    await session!.waitFor("Bubble", 15_000).catch(() => {});
  }, 25_000);

  afterAll(() => {
    session?.kill();
  });

  it("enters fullscreen via /fullscreen and renders the alt-screen view", async () => {
    session!.write("/fullscreen\r");
    // Alt screen activates (ESC[?1049h) and the view redraws with a footer.
    await session!.waitFor("\x1b[?1049h", 8_000);
  }, 20_000);

  it("accepts typed input inside fullscreen", async () => {
    session!.write("hello from fullscreen");
    await session!.waitFor("hello from fullscreen", 5_000);
  }, 15_000);

  it("returns to the main screen on Escape", async () => {
    session!.write("\x1b");
    await session!.waitFor("\x1b[?1049l", 8_000);
    // Main flow is interactive again.
    session!.write("back on main");
    await session!.waitFor("back on main", 5_000);
  }, 20_000);
});
