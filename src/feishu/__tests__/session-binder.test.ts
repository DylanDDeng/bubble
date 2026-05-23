/**
 * SessionBinder integration tests. We use the real SessionStore + SessionManager,
 * but redirect BUBBLE_HOME to a tmpdir so we don't pollute the user's directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../scope/session-store.js";
import { SessionBinder } from "../scope/session-binder.js";

let tmp: string;
let scopeCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bubble-feishu-test-"));
  // vi.stubEnv scopes the env mutation per-test even when workers share state.
  vi.stubEnv("BUBBLE_HOME", tmp);
  scopeCwd = join(tmp, "project");
  mkdirSync(scopeCwd, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

describe("SessionBinder", () => {
  it("bootstraps a fresh session on first call", () => {
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    const opened = binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    expect(opened.fresh).toBe(true);
    expect(opened.cwd).toBe(scopeCwd);
    expect(opened.permissionMode).toBe("default");
    expect(existsSync(opened.manager.getSessionFile())).toBe(true);
  });

  it("returns same session on subsequent calls", () => {
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    const first = binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    const second = binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    expect(second.fresh).toBe(false);
    expect(second.manager.getSessionFile()).toBe(first.manager.getSessionFile());
  });

  it("/cd creates a new session at the new cwd", () => {
    const otherCwd = join(tmp, "other");
    mkdirSync(otherCwd, { recursive: true });
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    const before = binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    const after = binder.changeCwd("oc_a:ou_x", otherCwd);
    expect(after.cwd).toBe(otherCwd);
    expect(after.fresh).toBe(true);
    expect(after.manager.getSessionFile()).not.toBe(before.manager.getSessionFile());
  });

  it("createFresh archives current pointer", () => {
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    const before = binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    const after = binder.createFresh("oc_a:ou_x", scopeCwd, "default");
    expect(after.manager.getSessionFile()).not.toBe(before.manager.getSessionFile());
    // The old file still exists on disk.
    expect(existsSync(before.manager.getSessionFile())).toBe(true);
  });

  it("setMode persists across reloads", () => {
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    binder.setMode("oc_a:ou_x", "bypassPermissions");
    const reloaded = SessionStore.load();
    expect(reloaded.get("oc_a:ou_x")?.permissionMode).toBe("bypassPermissions");
  });

  it("listResumable returns feishu-prefixed sessions only", () => {
    const store = SessionStore.load();
    const binder = new SessionBinder(store);
    binder.openOrBootstrap("oc_a:ou_x", scopeCwd, "default");
    binder.createFresh("oc_a:ou_x", scopeCwd, "default");
    const recent = binder.listResumable(scopeCwd, 10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    for (const s of recent) {
      expect(s.name.startsWith("feishu-")).toBe(true);
    }
  });
});
