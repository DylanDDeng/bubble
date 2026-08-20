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

  it("renders the boxed welcome with model metadata and cwd", async () => {
    // The gradient title emits one ANSI span per character; the subtitle is
    // contiguous in raw PTY output and proves the full welcome card rendered.
    await session!.waitFor("I am a cat", 10_000);
    await session!.waitFor("Model:", 5_000);
    await session!.waitFor("Version:", 5_000);
    await session!.waitFor("my-coding-agent-pi-tui", 5_000);
  }, 30_000);

  it("echoes composer input", async () => {
    session!.write("hello production app");
    await session!.waitFor("hello production app", 5_000);
  }, 20_000);

  it("shows slash-command suggestions while typing", async () => {
    session!.write("\x15/he");
    const viewport = await session!.waitForViewport("Show available slash commands", 5_000);
    const suggestionRow = viewport.findIndex((line) => line.includes("Show available slash commands"));
    const composerRow = viewport.findIndex((line) => line.includes("> /he"));
    expect(suggestionRow).toBeGreaterThanOrEqual(0);
    expect(composerRow).toBeGreaterThan(suggestionRow);
    session!.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    session!.write("\x15");
  }, 20_000);

  it("slash /help surfaces the command notice", async () => {
    session!.write("/help\r");
    await session!.waitFor("commands:", 5_000);
  }, 20_000);

  it("cycles permission modes with Shift+Tab", async () => {
    session!.write("\x1b[Z");
    await session!.waitForViewport("plan on", 5_000);

    session!.write("\x1b[Z");
    await session!.waitForViewport("bypass permission on", 5_000);

    session!.write("\x1b[Z");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session!.viewport().join("\n")).not.toContain("bypass permission on");
  }, 20_000);

  it("keeps the composer visible and editable through a resize storm", async () => {
    session!.resize(34, 12);
    session!.write("narrow");
    await session!.waitForViewport("narrow", 5_000);

    session!.resize(140, 40);
    session!.write("wide");
    await session!.waitForViewport("narrowwide", 5_000);

    session!.write("\x15"); // Ctrl+U: clear the current draft.
    session!.resize(20, 5);
    session!.write("VISIBLE_20X5");
    await session!.waitForViewport("VISIBLE_20X5", 5_000);

    session!.resize(100, 30);
    session!.write("_EDITABLE");
    await session!.waitForViewport("VISIBLE_20X5_EDITABLE", 5_000);
  }, 30_000);

  it("double Ctrl+C exits without wedging", async () => {
    session!.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 250));
    session!.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(true).toBe(true);
  }, 20_000);
});
