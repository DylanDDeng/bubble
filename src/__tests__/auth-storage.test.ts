/**
 * AuthStorage path resolution (known-defects #7): the auth file must resolve
 * at construction time through getBubbleHome — module-load freezing made the
 * real ~/.bubble/auth.json unavoidable in tests and ignored BUBBLE_HOME.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
