import { homedir } from 'node:os';
import { join } from 'node:path';

/** Match the SDK, including development mode when used outside the desktop bootstrap. */
export function resolveBubbleHome(): string {
  const explicit = process.env.BUBBLE_HOME?.trim();
  if (explicit) return explicit;
  const dev = ['1', 'true', 'yes', 'on'].includes(process.env.BUBBLE_DEV?.trim().toLowerCase() || '');
  return join(homedir(), dev ? '.bubble-dev' : '.bubble');
}
