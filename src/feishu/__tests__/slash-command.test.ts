/**
 * Smoke tests for the /feishu slash command. We exercise the no-config
 * branches; the spawn path is harder to test without integration and is
 * covered by manual verification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feishuCommand } from "../../slash-commands/feishu.js";
import type { SlashCommandContext } from "../../slash-commands/types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bubble-feishu-slash-"));
  vi.stubEnv("BUBBLE_HOME", tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

const ctxStub = {} as SlashCommandContext;

describe("/feishu slash command", () => {
  it("rejects unknown subcommand", async () => {
    const out = await feishuCommand.handler("frobnicate", ctxStub);
    expect(String(out)).toContain("Unknown subcommand");
  });

  it("status without config tells user to run --setup", async () => {
    const out = await feishuCommand.handler("status", ctxStub);
    expect(String(out)).toContain("not configured");
    expect(String(out)).toContain("--setup");
  });

  it("default subcommand is status", async () => {
    const out = await feishuCommand.handler("", ctxStub);
    expect(String(out)).toContain("not configured");
  });

  it("start without config refuses", async () => {
    const out = await feishuCommand.handler("start", ctxStub);
    expect(String(out)).toContain("Cannot start");
    expect(String(out)).toContain("--setup");
  });

  it("stop without config short-circuits", async () => {
    const out = await feishuCommand.handler("stop", ctxStub);
    expect(String(out)).toContain("nothing to stop");
  });

  it("logs without log files reports cleanly", async () => {
    const out = await feishuCommand.handler("logs", ctxStub);
    expect(String(out)).toContain("No log file");
  });

  it("setup without openPicker tells user to use shell", async () => {
    // ctxStub has no openPicker
    const out = await feishuCommand.handler("setup", ctxStub);
    expect(String(out)).toContain("interactive TUI mode");
  });

  it("setup calls openPicker when available", async () => {
    const calls: Array<{ mode: string; providerId?: string }> = [];
    const ctx = {
      openPicker: (mode: string, providerId?: string) => {
        calls.push({ mode, providerId });
      },
    } as unknown as SlashCommandContext;
    const out = await feishuCommand.handler("setup", ctx);
    // No string output on success — picker takes over.
    expect(out).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe("feishu-setup");
  });
});
