import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Launch commands choose the profile; inherited overrides cannot silently change it. */
export function createDesktopLaunchEnv(profile, inherited = process.env) {
  if (!['production', 'dev', 'qa'].includes(profile)) throw new Error(`Unknown desktop profile: ${profile}`);
  const env = { ...inherited, BUBBLE_DESKTOP_PROFILE: profile };
  for (const key of ['BUBBLE_HOME', 'BUBBLE_DEV', 'BUBBLE_DESKTOP_USER_DATA', 'AEGIS_USER_DATA_DIR', 'BUBBLE_DESKTOP_QA_ROOT', 'BUBBLE_DESKTOP_DEV_SERVER', 'DEV_SERVER_URL', 'VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  if (profile === 'qa') env.BUBBLE_DESKTOP_QA_ROOT = mkdtempSync(join(tmpdir(), 'bubble-desktop-qa-'));
  return env;
}
