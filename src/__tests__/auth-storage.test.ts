/**
 * AuthStorage path resolution (known-defects #7): the auth file must resolve
 * at construction time through getBubbleHome — module-load freezing made the
 * real ~/.bubble/auth.json unavoidable in tests and ignored BUBBLE_HOME.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("never runs the protected section without the lock while a live holder keeps it", async () => {
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const authPath = join(makeTempDir(), "auth.json");
    const lockPath = `${authPath}.lock`;
    writeFileSync(lockPath, "other-process-token");

    const fn = vi.fn(async () => undefined);
    const outcome = new AuthStorage(authPath).withRefreshLock(fn).then(() => "ran", (error: Error) => error.message);
    // A live holder heartbeats, so its lock never goes stale.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 5_000) {
      utimesSync(lockPath, new Date(), new Date());
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(await outcome).toMatch(/Timed out waiting for another Bubble process/);
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, "utf-8")).toBe("other-process-token");
  });

  it("does not delete a successor's lock when its own was broken as stale meanwhile", async () => {
    const authPath = join(makeTempDir(), "auth.json");
    const lockPath = `${authPath}.lock`;
    await new AuthStorage(authPath).withRefreshLock(async () => {
      // Simulates: we stalled, a waiter broke our lock and a successor took it.
      writeFileSync(lockPath, "successor-token");
    });
    expect(readFileSync(lockPath, "utf-8")).toBe("successor-token");
  });

  it("surfaces a lock that cannot be created instead of spinning on it", async () => {
    const notADir = join(makeTempDir(), "file");
    writeFileSync(notADir, "");
    const storage = new AuthStorage(join(notADir, "nested", "auth.json"));
    const fn = vi.fn(async () => undefined);
    await expect(storage.withRefreshLock(fn)).rejects.toThrow(/ENOTDIR|EEXIST|not a directory/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("recovers from a write lock left behind by a crashed process", () => {
    const authPath = join(makeTempDir(), "auth.json");
    const wlock = `${authPath}.wlock`;
    writeFileSync(wlock, "crashed-token");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(wlock, longAgo, longAgo);

    new AuthStorage(authPath).set("openai", creds("o"));
    expect(JSON.parse(readFileSync(authPath, "utf-8")).openai.refreshToken).toBe("refresh-o");
    expect(existsSync(wlock)).toBe(false);
  });

  // Real processes: the read-merge-write must not lose another writer's key.
  it("loses no update when several processes write different keys at once", async () => {
    const dir = makeTempDir();
    const authPath = join(dir, "auth.json");
    const script = join(dir, "writer.ts");
    const storageModule = join(process.cwd(), "src/oauth/storage.ts");
    writeFileSync(script, `
      import { AuthStorage } from ${JSON.stringify(storageModule)};
      const [authPath, id] = process.argv.slice(2);
      const storage = new AuthStorage(authPath);
      for (let i = 0; i < 25; i++) {
        storage.set(id + "-" + i, { type: "oauth", accessToken: "a", refreshToken: "r", expiresAt: 1 });
      }
    `);
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const writers = ["w1", "w2", "w3", "w4"];
    await Promise.all(writers.map((id) => new Promise<void>((resolve, reject) => {
      const child = spawn(tsx, [script, authPath, id], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}: ${stderr}`))));
    })));

    const keys = Object.keys(JSON.parse(readFileSync(authPath, "utf-8")));
    expect(keys).toHaveLength(writers.length * 25);
  }, 60_000);
});
