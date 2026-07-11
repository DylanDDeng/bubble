import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseClashHttpProxyPort,
  resolveGrokNetworkRoute,
} from "../external-runtime/grok-network.js";

describe("Grok network route", () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("uses direct xAI connectivity as the normal subscription path", async () => {
    const probe = vi.fn(async (proxy?: string) => proxy === undefined);
    await expect(resolveGrokNetworkRoute({ probe })).resolves.toEqual({ source: "direct" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith();
  });

  it("automatically follows an owned local Mac route when direct access fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "bubble-grok-network-"));
    homes.push(home);
    const directory = join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const config = join(directory, "config.yaml");
    await writeFile(config, "mixed-port: 7897\nport: 7899\n", { mode: 0o600 });
    await chmod(config, 0o600);
    const probe = vi.fn(async (proxy?: string) => proxy === "http://127.0.0.1:7897");
    await expect(resolveGrokNetworkRoute({
      platform: "darwin", userHome: home, uid: process.getuid?.(), probe,
    })).resolves.toEqual({ source: "clash-verge", proxy: "http://127.0.0.1:7897" });
    expect(probe.mock.calls.map(([proxy]) => proxy)).toEqual([undefined, "http://127.0.0.1:7897"]);
  });

  it("fails clearly without asking the user to enter an address", async () => {
    const home = await mkdtemp(join(tmpdir(), "bubble-grok-network-empty-"));
    homes.push(home);
    await expect(resolveGrokNetworkRoute({
      platform: "darwin", userHome: home, uid: process.getuid?.(), probe: async () => false,
    })).rejects.toMatchObject({
      code: "not_authenticated",
      message: expect.stringContaining("current network configuration"),
    });
  });

  it("parses only valid local HTTP ports", () => {
    expect(parseClashHttpProxyPort("mixed-port: 7897\nport: 7899\n")).toBe(7897);
    expect(parseClashHttpProxyPort("port: 7899\n")).toBe(7899);
    expect(parseClashHttpProxyPort("mixed-port: 0\nport: 70000\n")).toBeUndefined();
  });
});
