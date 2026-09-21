import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, linkSync, readFileSync, unlinkSync } from "node:fs";

function ownerPid(token: string): number | undefined {
  const pid = Number(token.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function deadOwner(token: string): boolean {
  const pid = ownerPid(token);
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Identity of one incarnation of a pid: the OS start time of the process that
 * currently has it. Pids are recycled, so a pid that answers kill(0) may be an
 * unrelated process; only a matching start time proves it is the same owner.
 * Undefined when the platform cannot say, which callers treat as "unknown",
 * never as "gone". Exported for tests. */
export function processStartId(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      // Field 22 (starttime); the comm field may itself contain spaces/parens.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
    }
    if (process.platform === "win32") return undefined;
    // lstart is rendered in the caller's locale and time zone. Owner and
    // contender can be different hosts (terminal TUI vs GUI desktop) with
    // different environments, so pin both or a live owner looks recycled.
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" },
    }).trim() || undefined;
  } catch { return undefined; }
}

let ownStartId: string | undefined | null = null;
function ownerToken(): string {
  if (ownStartId === null) ownStartId = processStartId(process.pid);
  // Start ids contain ":" (ps lstart) — keep pid and uuid as the leading fields.
  return `${process.pid}:${randomUUID()}${ownStartId ? `:${ownStartId}` : ""}`;
}

/** The pid is alive but belongs to a different process than the one that took
 * the lock. Elapsed age is deliberately NOT evidence: a live writer can be
 * suspended or stalled in fsync for arbitrarily long. */
function recycledOwner(token: string): boolean {
  const pid = ownerPid(token);
  const recorded = token.split(":").slice(2).join(":");
  if (pid === undefined || !recorded) return false; // Legacy token: unknown, never expire.
  const current = processStartId(pid);
  return current !== undefined && current !== recorded;
}

function release(path: string, token: string): void {
  try { if (readFileSync(path, "utf8") === token) unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Publish a fully written owner atomically. No empty lock can be left by a crash. */
function publish(path: string, token: string): void {
  // Only pid and uuid: the start id may hold spaces and colons.
  const owner = `${path}.${token.split(":").slice(0, 2).join("-")}.owner`;
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

/** Synchronous short transaction lock. An owner is abandoned only when its
 * process is provably gone: the pid no longer exists, or it now belongs to a
 * different process incarnation. Live owners are never expired by age;
 * contenders wait a bounded time for them, since transactions are short. */
export function withSessionWriteLock<T>(path: string, action: () => T, waitMs = LIVE_OWNER_WAIT_MS): T {
  const token = ownerToken();
  const deadline = Date.now() + waitMs;
  const verifiedLive = new Set<string>(); // One incarnation probe per observed owner.
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try { publish(path, token); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new SessionWriteLockBusyError(path);
      let observed: string;
      try { observed = readFileSync(path, "utf8"); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; throw readError; }
      // kill(0) is cheap and re-checked every round; the incarnation probe may
      // spawn `ps`, so a given owner is probed once per acquisition.
      const abandoned = () => deadOwner(observed) || (!verifiedLive.has(observed) && recycledOwner(observed));
      if (!abandoned()) { verifiedLive.add(observed); sleepSync(delay); continue; }
      // Serialize recovery. Recovery locks themselves use the same owner-safe
      // protocol, so killing a recovering process cannot permanently block it.
      withSessionWriteLock(`${path}.recovery`, () => {
        try { if (readFileSync(path, "utf8") === observed && abandoned()) unlinkSync(path); }
        catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError; }
      }, Math.max(0, deadline - Date.now()));
    }
  }
  try { return action(); } finally { release(path, token); }
}
