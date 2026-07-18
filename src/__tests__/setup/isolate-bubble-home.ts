import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point BUBBLE_HOME at a throwaway directory for the whole test run — always,
// even when the shell exports one. Without this, any code path that
// constructs UserConfig (e.g. persistSelectedModel via /login grok or /model)
// writes to the developer's real ~/.bubble — every test run silently reset
// defaultModel to grok:grok-4.5. Tests that need their own home still
// override BUBBLE_HOME locally.
process.env.BUBBLE_HOME = mkdtempSync(join(tmpdir(), "bubble-test-home-"));
