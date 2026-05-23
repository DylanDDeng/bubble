/**
 * First-time setup wizard.
 *
 *  Flow:
 *    1. Call `registerApp` from the SDK — it returns a QR code URL that
 *       points at Feishu's app-registration page; user scans on phone to
 *       create an app and authorize us.
 *    2. We receive `{ client_id, client_secret, user_info.open_id }`.
 *    3. Encrypt the secret to `secrets.enc`, write `config.json`, prompt
 *       the user (in terminal) for the first scope (chat_id + cwd).
 *    4. Persist the scope to `scopes.json`.
 *
 *  The terminal prompts use a tiny line-mode reader (readline). We don't
 *  pull in @clack to keep dependencies flat.
 */

import { registerApp } from "@larksuiteoapi/node-sdk";
import qrTerminal from "qrcode-terminal";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { bootstrapConfig } from "./config.js";
import { ScopeRegistry } from "./scope/scope-registry.js";
import type { FeishuConfig, ScopeConfig } from "./types.js";

export interface WizardResult {
  config: FeishuConfig;
  firstScope?: { chatId: string; scope: ScopeConfig };
}

export async function runWizard(): Promise<WizardResult> {
  console.log(chalk.bold("\n🫧 Bubble Feishu setup\n"));
  console.log("This will register a Feishu personal-agent app, encrypt the secret to your");
  console.log("keystore, and let you bind your first chat to a local directory.\n");

  const registered = await runQrFlow();
  console.log(chalk.green(`✅ Registered. owner open_id: ${registered.userInfo?.open_id ?? "(unknown)"}\n`));

  const ownerOpenId = registered.userInfo?.open_id ?? "";
  if (!ownerOpenId) {
    throw new Error("registerApp did not return user_info.open_id — cannot continue.");
  }

  const config = bootstrapConfig({
    appId: registered.clientId,
    appSecret: registered.clientSecret,
    ownerOpenId,
  });
  console.log(chalk.dim(`Wrote config + encrypted secret to ~/.bubble/feishu/\n`));

  // Optional first-scope binding.
  console.log("Want to bind a chat to a local directory now? You can also do this later by");
  console.log("editing ~/.bubble/feishu/scopes.json directly.\n");
  const wantBind = await ask("Bind a chat now? [y/N]: ");
  if (!/^y/i.test(wantBind.trim())) {
    return { config };
  }

  const chatId = (await ask("Chat ID (oc_...): ")).trim();
  if (!chatId.startsWith("oc_")) {
    console.log(chalk.yellow("Chat IDs typically start with `oc_`. Continuing anyway."));
  }
  const cwdInput = (await ask(`Local cwd to bind (e.g. ${homedir()}/projects/my-app): `)).trim();
  const expandedCwd = expandUser(cwdInput);
  if (!isAbsolute(expandedCwd) || !existsSync(expandedCwd) || !statSync(expandedCwd).isDirectory()) {
    throw new Error(`Invalid cwd: ${expandedCwd} (must be an existing absolute directory)`);
  }
  const displayName = (await ask("Display name (short label for the card header): ")).trim() || basenameSafe(expandedCwd);

  const scope: ScopeConfig = {
    cwd: expandedCwd,
    displayName,
    allowedUsers: [ownerOpenId],
    admins: [ownerOpenId],
    defaultPermissionMode: "default",
    model: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  const registry = ScopeRegistry.load();
  registry.upsert(chatId, scope);
  console.log(chalk.green(`\n✅ Bound chat ${chatId} → ${expandedCwd}\n`));

  return { config, firstScope: { chatId, scope } };
}

interface RegisterResult {
  clientId: string;
  clientSecret: string;
  userInfo?: { open_id?: string };
}

async function runQrFlow(): Promise<RegisterResult> {
  console.log("Opening QR code below. Scan with your Feishu mobile app and authorize.\n");
  return new Promise<RegisterResult>((resolve, reject) => {
    let printed = false;
    void registerApp({
      onQRCodeReady: (info) => {
        if (!printed) {
          qrTerminal.generate(info.url, { small: true }, (code) => {
            process.stdout.write(code + "\n");
            console.log(chalk.dim(`(QR expires in ${info.expireIn}s)`));
          });
          printed = true;
        }
      },
      onStatusChange: (info) => {
        if (info.status === "slow_down") console.log(chalk.dim("(polling slowed — still waiting…)"));
        if (info.status === "domain_switched") console.log(chalk.dim("(domain switched)"));
      },
    })
      .then((res) => {
        resolve({
          clientId: res.client_id,
          clientSecret: res.client_secret,
          userInfo: res.user_info,
        });
      })
      .catch(reject);
  });
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) return homedir() + p.slice(1);
  return resolvePath(p);
}

function basenameSafe(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
