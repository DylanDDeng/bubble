import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareVersions,
  getCurrentVersion,
  startStartupUpdateCheck,
  upgradeCommandFor,
  PACKAGE_NAME,
} from "../update/index.js";

describe("compareVersions", () => {
  it("orders numeric cores", () => {
    expect(compareVersions("0.0.15", "0.0.14")).toBe(1);
    expect(compareVersions("0.0.14", "0.0.15")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
    expect(compareVersions("0.0.14", "0.0.14")).toBe(0);
  });

  it("tolerates a leading v and short versions", () => {
    expect(compareVersions("v0.0.15", "0.0.14")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("treats a release as newer than a pre-release of the same core", () => {
    expect(compareVersions("0.0.14", "0.0.14-beta.1")).toBe(1);
    expect(compareVersions("0.0.14-beta.1", "0.0.14")).toBe(-1);
    expect(compareVersions("0.0.14-beta.2", "0.0.14-beta.1")).toBe(1);
  });
});

describe("upgradeCommandFor", () => {
  const spec = `${PACKAGE_NAME}@latest`;

  it("maps known managers to global install commands", () => {
    expect(upgradeCommandFor("npm")).toEqual({ cmd: "npm", args: ["install", "-g", spec] });
    expect(upgradeCommandFor("bun")).toEqual({ cmd: "bun", args: ["add", "-g", spec] });
    expect(upgradeCommandFor("pnpm")).toEqual({ cmd: "pnpm", args: ["add", "-g", spec] });
    expect(upgradeCommandFor("yarn")).toEqual({ cmd: "yarn", args: ["global", "add", spec] });
  });

  it("defaults unknown to npm and returns null for homebrew", () => {
    expect(upgradeCommandFor("unknown")).toEqual({ cmd: "npm", args: ["install", "-g", spec] });
    expect(upgradeCommandFor("homebrew")).toBeNull();
  });
});

describe("startStartupUpdateCheck", () => {
  const previousHome = process.env.BUBBLE_HOME;
  const current = getCurrentVersion();

  function setupHome(cache?: { lastCheck: number; latest: string }): string {
    const home = join(tmpdir(), `bubble-update-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(home, { recursive: true });
    if (cache) writeFileSync(join(home, "update-check.json"), JSON.stringify(cache));
    process.env.BUBBLE_HOME = home;
    return home;
  }

  function stubRegistry(version: string | null) {
    const fetchMock = vi.fn(async () => {
      if (version === null) throw new Error("network down");
      return { ok: true, json: async () => ({ version }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = previousHome;
  });

  it("returns an immediate notice from a cache that already knows a newer version", async () => {
    setupHome({ lastCheck: Date.now(), latest: "99.0.0" });
    const fetchMock = stubRegistry("99.0.0");

    const check = await startStartupUpdateCheck();

    expect(check.notice).toContain(`v${current} → v99.0.0`);
    // Fresh cache: the throttle suppresses the network refresh entirely.
    expect(await check.refreshed).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a release published since the last launch in the same session", async () => {
    const home = setupHome(); // no cache at all
    const fetchMock = stubRegistry("99.0.0");

    const check = await startStartupUpdateCheck();

    expect(check.notice).toBeNull();
    expect(await check.refreshed).toContain(`v${current} → v99.0.0`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"));
    expect(written.latest).toBe("99.0.0");
  });

  it("refreshes a stale cache and notifies when the registry has something newer", async () => {
    setupHome({ lastCheck: Date.now() - 60 * 60 * 1000, latest: current });
    stubRegistry("99.0.0");

    const check = await startStartupUpdateCheck();

    expect(check.notice).toBeNull();
    expect(await check.refreshed).toContain("v99.0.0");
  });

  it("does not repeat a notice the cache already surfaced", async () => {
    setupHome({ lastCheck: Date.now() - 60 * 60 * 1000, latest: "99.0.0" });
    stubRegistry("99.0.0");

    const check = await startStartupUpdateCheck();

    expect(check.notice).toContain("v99.0.0");
    expect(await check.refreshed).toBeNull();
  });

  it("stays quiet when the registry is unreachable", async () => {
    const home = setupHome();
    stubRegistry(null);

    const check = await startStartupUpdateCheck();

    expect(check.notice).toBeNull();
    expect(await check.refreshed).toBeNull();
    expect(existsSync(join(home, "update-check.json"))).toBe(false);
  });

  it("stays quiet when already on the latest version", async () => {
    setupHome();
    stubRegistry(current);

    const check = await startStartupUpdateCheck();

    expect(check.notice).toBeNull();
    expect(await check.refreshed).toBeNull();
  });
});
