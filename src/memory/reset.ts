import { MemoryDatabase } from "./db.js";
import { resetMemoryWorkspace } from "./storage.js";

export function resetMemory(cwd: string): string {
  const db = new MemoryDatabase(cwd);
  try {
    db.resetStageData();
  } finally {
    db.close();
  }
  resetMemoryWorkspace(cwd);
  return "Memory reset complete.";
}
