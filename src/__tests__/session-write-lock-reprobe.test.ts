import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The `ps` probe is the only incarnation source off Linux; script its answers.
const lstart = vi.hoisted(() => ({ answers: [] as string[] }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: () => lstart.answers.length > 1 ? lstart.answers.shift()! : lstart.answers[0],
}));

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe.skipIf(process.platform === "linux" || process.platform === "win32")("write lock owner re-probe", () => {
  it("recovers an owner that exits and has its pid recycled during the wait", async () => {
    const { withSessionWriteLock } = await import("../context/session-write-lock.js");
    const dir = mkdtempSync(join(tmpdir(), "bubble-lock-reprobe-"));
    dirs.push(dir);
    const lock = join(dir, "session.jsonl.write-lock");
    // First answer is our own start id (token creation), then the owner's first
    // probe matches its record (alive, same incarnation); every later probe sees
    // a different process on that pid. kill(0) says "alive" throughout.
    lstart.answers = ["SELF", "OWNER-START", "SOMEONE-ELSE"];
    writeFileSync(lock, `${process.pid}:owner:OWNER-START`);

    expect(withSessionWriteLock(lock, () => "ran", 60)).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });
});
