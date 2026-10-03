import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import {
  describeRepoCapabilities,
  isRepoConfigTrusted,
  mergedRepoCapabilities,
  readRepoSettings,
  trustRepoConfig,
} from "./trust.js";

/**
 * Folder trust, the Kimi Code way: when the repository's `.bubble` settings
 * would grant something (allow rules, MCP servers, LSP servers), ask once at
 * startup before any of it loads. Trusting records the exact settings; any
 * later change asks again. Declining keeps them off for this run only.
 */
export async function promptRepoTrust(
  cwd: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  // Read once: what gets trusted is exactly what was shown.
  const raw = readRepoSettings(cwd);
  if (isRepoConfigTrusted(cwd, raw)) return true;
  const say = (line: string) => io.output.write(`${line}\n`);
  say(chalk.bold(`\nThis folder's .bubble settings would enable:`));
  for (const line of describeRepoCapabilities(mergedRepoCapabilities(raw))) say(`  ${line}`);
  say(chalk.dim("Only trust folders whose settings you have reviewed; MCP servers run commands on your machine."));
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const answer = (await rl.question("Trust this folder? [Y/n] ")).trim().toLowerCase();
    const trusted = answer === "" || answer === "y" || answer === "yes";
    if (trusted) trustRepoConfig(cwd, raw);
    say(chalk.dim(trusted
      ? "Trusted. Any change to these settings will ask again.\n"
      : "Not trusted: these settings stay off this session.\n"));
    return trusted;
  } finally {
    rl.close();
  }
}
