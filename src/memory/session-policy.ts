import { existsSync } from "node:fs";
import { SessionManager } from "../session.js";
import { MemoryDatabase } from "./db.js";
import { clearGeneratedMemoryOutputs } from "./storage.js";

export type MemorySessionClassification =
  | { kind: "native"; session: SessionManager }
  | { kind: "external"; session: SessionManager }
  | { kind: "unavailable" };

/**
 * Classify a persisted Bubble session before its content can enter the native
 * memory pipeline. Unreadable sources are not assumed to be native: phase 2
 * must be able to verify the persisted metadata before reusing a stage-1 row.
 */
export function classifyMemorySession(sessionFile: string): MemorySessionClassification {
  if (!existsSync(sessionFile)) return { kind: "unavailable" };

  try {
    const session = new SessionManager(sessionFile);
    return session.getMetadata().externalRuntime === undefined
      ? { kind: "native", session }
      : { kind: "external", session };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Validate persisted stage-1 provenance before generated memory can be read
 * into a native provider prompt. Any unverifiable or external source makes
 * the existing generated artifacts unsafe as a unit: clear them first, then
 * remove the offending rows so a later phase 2 can rebuild from native-only
 * inputs. Clearing before deleting is intentional so a crash cannot leave a
 * contaminated artifact with no database row that identifies its source.
 */
export function purgeUnsafeMemorySources(cwd: string): number {
  let db: MemoryDatabase | undefined;
  try {
    db = new MemoryDatabase(cwd);
    const outputs = db.listAllStage1Outputs();
    const unsafe = outputs.filter((output) => classifyMemorySession(output.sessionFile).kind !== "native");
    if (unsafe.length === 0) {
      if (outputs.length === 0) clearGeneratedMemoryOutputs(cwd);
      return 0;
    }

    clearGeneratedMemoryOutputs(cwd);
    for (const output of unsafe) db.deleteStage1Output(output.sessionFile);
    return unsafe.length;
  } catch {
    // Generated memory without verifiable provenance must never be injected.
    clearGeneratedMemoryOutputs(cwd);
    return 0;
  } finally {
    db?.close();
  }
}
