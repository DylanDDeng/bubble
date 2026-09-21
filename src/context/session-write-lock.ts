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

/** Synchronous short transaction lock. Live owners are never expired by age. */
export function withSessionWriteLock<T>(path: string, action: () => T): T {
  const token = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { publish(path, token); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 2) throw error;
      let observed: string;
      try { observed = readFileSync(path, "utf8"); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; throw readError; }
      if (!deadOwner(observed)) throw error;
      // Serialize recovery. Recovery locks themselves use the same owner-safe
      // protocol, so killing a recovering process cannot permanently block it.
      withSessionWriteLock(`${path}.recovery`, () => {
        try { if (readFileSync(path, "utf8") === observed && deadOwner(observed)) unlinkSync(path); }
        catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError; }
      });
    }
  }
  try { return action(); } finally { release(path, token); }
}
