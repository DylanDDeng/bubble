import { randomUUID } from "node:crypto";
import { writeFileSync, linkSync, readFileSync, statSync, unlinkSync } from "node:fs";

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
// Transactions are synchronous and millisecond-scale. A pid that answers
// kill(0) may be an unrelated process that recycled a crashed owner's pid, so
// liveness alone cannot make a lock permanent.
const ABANDONED_LOCK_AGE_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void { Atomics.wait(sleepCell, 0, 0, ms); }

function lockAgeMs(path: string): number {
  try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; }
}

/** Remove `observed` if it still owns the lock and `abandoned` still holds.
 * Recovery locks use the same owner-safe protocol, so killing a recovering
 * process cannot permanently block it. */
function recover(path: string, observed: string, abandoned: () => boolean, waitMs: number): void {
  withSessionWriteLock(`${path}.recovery`, () => {
    try { if (readFileSync(path, "utf8") === observed && abandoned()) unlinkSync(path); }
    catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError; }
  }, waitMs);
}

/** Synchronous short transaction lock. Contenders wait a bounded time for a
 * live owner. An owner is abandoned when its process is gone, or when the same
 * token is old AND stayed put for the contender's entire wait: a real owner
 * finishes in milliseconds (even one resumed from system sleep releases within
 * that wait), whereas a recycled pid never does. */
export function withSessionWriteLock<T>(path: string, action: () => T, waitMs = LIVE_OWNER_WAIT_MS): T {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  let heldThroughout: string | undefined;
  let expired = false;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try { publish(path, token); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observed: string;
      try { observed = readFileSync(path, "utf8"); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
        if (Date.now() >= deadline) throw new SessionWriteLockBusyError(path);
        continue;
      }
      if (deadOwner(observed)) { recover(path, observed, () => deadOwner(observed), Math.max(0, deadline - Date.now())); continue; }
      heldThroughout = heldThroughout === undefined || heldThroughout === observed ? observed : "";
      if (Date.now() < deadline) { sleepSync(delay); continue; }
      if (expired || heldThroughout !== observed || lockAgeMs(path) < ABANDONED_LOCK_AGE_MS) {
        throw new SessionWriteLockBusyError(path);
      }
      expired = true; // One expiry per acquisition: never loop on a contended path.
      recover(path, observed, () => lockAgeMs(path) >= ABANDONED_LOCK_AGE_MS, waitMs);
    }
  }
  try { return action(); } finally { release(path, token); }
}
