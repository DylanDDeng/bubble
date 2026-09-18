/**
 * AuthStorage path resolution (known-defects #7): the auth file must resolve
 * at construction time through getBubbleHome — module-load freezing made the
 * real ~/.bubble/auth.json unavoidable in tests and ignored BUBBLE_HOME.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../oauth/storage.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bubble-auth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("AuthStorage path resolution", () => {
  it("reads and writes an explicitly injected path", () => {
    const authPath = join(makeTempDir(), "auth.json");
    const storage = new AuthStorage(authPath);

    storage.set("openai", { type: "oauth", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 60_000 });

    expect(storage.getPath()).toBe(authPath);
    expect(existsSync(authPath)).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf-8")).openai.accessToken).toBe("a");

    // A second instance over the same path sees the persisted entry.
    expect(new AuthStorage(authPath).has("openai")).toBe(true);
  });

  it("honors BUBBLE_HOME at construction time, not module load", () => {
    const home = makeTempDir();
    const previous = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = home;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previous;
    });

    // The module was imported long before BUBBLE_HOME was set — the path
    // must still land under it, proving resolution happens per construction.
    const storage = new AuthStorage();
    expect(storage.getPath()).toBe(join(home, "auth.json"));

    storage.set("grok", { type: "oauth", accessToken: "g", refreshToken: "gr", expiresAt: Date.now() + 60_000 });
    expect(existsSync(join(home, "auth.json"))).toBe(true);
  });
});

// auth.json is shared by every Bubble process; two AuthStorage instances over
// one path stand in for two processes.
describe("AuthStorage shared between processes", () => {
  const creds = (tag: string) => ({
    type: "oauth" as const,
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    expiresAt: Date.now() + 60_000,
  });

  it("does not clobber an entry another process rotated when writing a different key", () => {
    const authPath = join(makeTempDir(), "auth.json");
    new AuthStorage(authPath).set("openai", creds("old"));
    const a = new AuthStorage(authPath);
    const b = new AuthStorage(authPath); // loaded the old openai entry

    a.set("openai", creds("rotated"));
    b.set("grok", creds("grok")); // used to dump b's stale openai entry back

    const onDisk = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(onDisk.openai.refreshToken).toBe("refresh-rotated");
    expect(onDisk.grok.refreshToken).toBe("refresh-grok");
  });

  it("reads follow a rotation made by another process and notify listeners", () => {
    const authPath = join(makeTempDir(), "auth.json");
    new AuthStorage(authPath).set("openai", creds("old"));
    const reader = new AuthStorage(authPath);
    const changed: string[] = [];
    reader.onMutation((key) => changed.push(key));

    new AuthStorage(authPath).set("openai", { ...creds("rotated"), accessToken: "a-much-longer-access-token" });

    expect(reader.get("openai")!.refreshToken).toBe("refresh-rotated");
    expect(changed).toEqual(["openai"]);
  });

  it("remove only drops its own key", () => {
    const authPath = join(makeTempDir(), "auth.json");
    const a = new AuthStorage(authPath);
    const b = new AuthStorage(authPath);
    a.set("openai", creds("o"));
    b.set("grok", creds("g"));
    a.remove("openai");
    expect(Object.keys(JSON.parse(readFileSync(authPath, "utf-8")))).toEqual(["grok"]);
  });

  it("withRefreshLock serializes holders across instances", async () => {
    const authPath = join(makeTempDir(), "auth.json");
    const a = new AuthStorage(authPath);
    const b = new AuthStorage(authPath);
    const order: string[] = [];
    const first = a.withRefreshLock(async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      order.push("a:end");
    });
    const second = b.withRefreshLock(async () => {
      order.push("b:start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    expect(existsSync(`${authPath}.lock`)).toBe(false);
  });

  it("breaks a lock left behind by a crashed process instead of hanging", async () => {
    const authPath = join(makeTempDir(), "auth.json");
    const lockPath = `${authPath}.lock`;
    writeFileSync(lockPath, "");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const startedAt = Date.now();
    await new AuthStorage(authPath).withRefreshLock(async () => undefined);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the holder throws", async () => {
    const authPath = join(makeTempDir(), "auth.json");
    const storage = new AuthStorage(authPath);
    await expect(storage.withRefreshLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(`${authPath}.lock`)).toBe(false);
  });
});
