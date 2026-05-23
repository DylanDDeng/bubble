/**
 * FeishuConfig load / save. Failures surface as thrown errors with helpful
 * remediation hints; callers (serve.ts) translate them into user-facing
 * messages.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { getConfigPath, getSecretsPath } from "./paths.js";
import { validateFeishuConfig } from "./schema.js";
import type { FeishuConfig } from "./types.js";
import { DEFAULT_PREFERENCES, DEFAULT_GLOBAL_LIMITS } from "./types.js";
import { decryptSecret, encryptWithSelfCheck, loadKeystoreFile, saveKeystoreFile } from "./secrets.js";

export class FeishuConfigError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "FeishuConfigError";
  }
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function loadConfig(): FeishuConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    throw new FeishuConfigError(
      `No Feishu config found at ${path}`,
      "Run `bubble serve --feishu --setup` to create one.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new FeishuConfigError(`Failed to read config: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FeishuConfigError(`Config is not valid JSON: ${(err as Error).message}`);
  }
  const result = validateFeishuConfig(parsed);
  if (!result.ok || !result.value) {
    throw new FeishuConfigError(
      `Config has invalid shape:\n  - ${result.errors.join("\n  - ")}`,
      `Edit ${path} or rerun --setup.`,
    );
  }
  return result.value;
}

export function saveConfig(config: FeishuConfig): void {
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort.
  }
}

export function resolveAppSecret(config: FeishuConfig): string {
  const ref = config.app.secretRef;
  if (ref.source === "env") {
    const value = process.env[ref.varName];
    if (!value || !value.trim()) {
      throw new FeishuConfigError(
        `Env var ${ref.varName} (referenced by config.app.secretRef) is empty or unset`,
        `Set it in your shell before running, e.g. \`export ${ref.varName}=...\``,
      );
    }
    return value.trim();
  }
  if (ref.source === "keystore") {
    try {
      const record = loadKeystoreFile(getSecretsPath());
      return decryptSecret(record);
    } catch (err) {
      throw new FeishuConfigError(
        `Failed to load App Secret from keystore: ${(err as Error).message}`,
        "Rerun `bubble serve --feishu --setup` to regenerate.",
      );
    }
  }
  throw new FeishuConfigError(`Unknown secretRef.source: ${(ref as { source: string }).source}`);
}

export interface BootstrapInput {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
}

/**
 * First-time setup: encrypt the secret, write keystore + config files.
 * Used by the wizard after a successful registerApp() flow.
 */
export function bootstrapConfig(input: BootstrapInput): FeishuConfig {
  const { record, check } = encryptWithSelfCheck(input.appSecret);
  saveKeystoreFile(getSecretsPath(), record);
  const config: FeishuConfig = {
    version: 1,
    app: {
      appId: input.appId,
      ownerOpenId: input.ownerOpenId,
      secretRef: { source: "keystore", name: "default" },
      encryptCheck: check,
    },
    preferences: { ...DEFAULT_PREFERENCES },
    globalLimits: { ...DEFAULT_GLOBAL_LIMITS },
  };
  saveConfig(config);
  return config;
}
