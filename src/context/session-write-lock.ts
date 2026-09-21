import { randomUUID } from "node:crypto";
import { writeFileSync, linkSync, readFileSync, unlinkSync } from "node:fs";

function deadOwner(token: string): boolean {
  const pid = Number(token.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function release(path: string, token: string): void {
  try { if (readFileSync(path, "utf8") === token) unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Publish a fully written owner atomically. No empty lock can be left by a crash. */
function publish(path: string, token: string): void {
  const owner = `${path}.${token.replace(":", "-")}.owner`;
  writeFileSync(owner, token, { mode: 0o600, flag: "wx" });
  try { linkSync(owner, path); } finally { unlinkSync(owner); }
}

/** A live owner held the lock past the bounded wait. Nothing was written. */
export class SessionWriteLockBusyError extends Error {
  constructor(path: string) {
    super(`Session write lock is held by another live writer: ${path}`);
    this.name = "SessionWriteLockBusyError";
  }
}

const LIVE_OWNER_WAIT_MS = 2_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void { Atomics.wait(sleepCell, 0, 0, ms); }

/** Synchronous short transaction lock. Live owners are never expired by age;
 * contenders wait a bounded time for them, since transactions are short. */
export function withSessionWriteLock<T>(path: string, action: () => T, waitMs = LIVE_OWNER_WAIT_MS): T {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try { publish(path, token); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new SessionWriteLockBusyError(path);
      let observed: string;
      try { observed = readFileSync(path, "utf8"); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; throw readError; }
      if (!deadOwner(observed)) { sleepSync(delay); continue; }
      // Serialize recovery. Recovery locks themselves use the same owner-safe
      // protocol, so killing a recovering process cannot permanently block it.
      withSessionWriteLock(`${path}.recovery`, () => {
        try { if (readFileSync(path, "utf8") === observed && deadOwner(observed)) unlinkSync(path); }
        catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError; }
      }, Math.max(0, deadline - Date.now()));
    }
  }
  try { return action(); } finally { release(path, token); }
}
