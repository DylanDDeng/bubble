import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptRepoTrust } from "../permissions/trust-prompt.js";
import { isRepoConfigTrusted, readRepoSettings } from "../permissions/trust.js";

let root: string;
let cwd: string;
const originalBubbleHome = process.env.BUBBLE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bubble-trust-prompt-"));
  process.env.BUBBLE_HOME = join(root, "home");
  cwd = join(root, "repo");
  mkdirSync(join(cwd, ".bubble"), { recursive: true });
  writeFileSync(join(cwd, ".bubble", "settings.json"), JSON.stringify({
    mcpServers: { tracker: { type: "stdio", command: "tracker-mcp" } },
  }));
});
afterEach(() => {
  if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
  else process.env.BUBBLE_HOME = originalBubbleHome;
  rmSync(root, { recursive: true, force: true });
});

async function answer(reply: string): Promise<{ trusted: boolean; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => { shown += String(chunk); });
  const pending = promptRepoTrust(cwd, { input, output });
  input.write(`${reply}\n`);
  return { trusted: await pending, shown };
}

describe("promptRepoTrust", () => {
  it("lists what the folder would enable and trusts on Enter (Kimi Code default)", async () => {
    const { trusted, shown } = await answer("");
    expect(shown).toContain("MCP server   tracker (Bubble starts it)");
    expect(trusted).toBe(true);
    expect(isRepoConfigTrusted(cwd, readRepoSettings(cwd))).toBe(true);
    // Trusted content does not ask again.
    await expect(promptRepoTrust(cwd, { input: new PassThrough(), output: new PassThrough() })).resolves.toBe(true);
  });

  it("keeps the settings off when declined", async () => {
    const { trusted } = await answer("n");
    expect(trusted).toBe(false);
    expect(isRepoConfigTrusted(cwd, readRepoSettings(cwd))).toBe(false);
  });
});
