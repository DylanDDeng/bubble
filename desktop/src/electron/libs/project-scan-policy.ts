import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

export interface ProjectScanPolicy { home?: string; platform?: NodeJS.Platform }
export const PROJECT_SCAN_NOTICE = 'Choose a specific project folder. Home, system and private app folders are not indexed.';

function policyPath(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path);
  // The APFS data-volume alias must have the same policy as /Users, /Library, etc.
  return platform === 'darwin'
    ? normalized.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '').toLowerCase() || '/'
    : normalized;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !parse(rel).root);
}

/** Check before filesystem access, not after a permission error has prompted. */
export function isPrivateProjectPath(path: string, options: ProjectScanPolicy = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const target = policyPath(path, platform);
  const home = policyPath(options.home ?? homedir(), platform);
  if (['/system', '/library', '/private/var/db', '/private/var/root'].some(root => within(root, target))) return true;
  if (['Library', 'Music', 'Pictures', 'Movies', '.Trash'].some(name => within(join(home, name.toLowerCase()), target))) return true;
  // Other users' private app/media folders are not project indexes either.
  if (/^\/users\/[^/]+\/(library|music|pictures|movies|\.trash)(\/|$)/i.test(target)) return true;
  return target.split(sep).some(name => /\.(app|photoslibrary|photolibrary|musiclibrary|backupbundle|sparsebundle)$/i.test(name));
}

export function projectScanRestriction(path: string, options: ProjectScanPolicy = {}): string | null {
  const platform = options.platform ?? process.platform;
  const target = policyPath(path, platform);
  const home = policyPath(options.home ?? homedir(), platform);
  if (within(target, home) || isPrivateProjectPath(path, options)) return PROJECT_SCAN_NOTICE;
  if (['Desktop', 'Documents', 'Downloads', 'Public', 'Applications'].some(name => target === policyPath(join(home, name), platform))) return PROJECT_SCAN_NOTICE;
  if (platform === 'darwin' && (/^\/(users|volumes|network)(\/[^/]+)?$/.test(target)
    || ['/applications', '/private', '/private/var', '/private/tmp', '/tmp', '/var', '/opt', '/usr'].includes(target))) return PROJECT_SCAN_NOTICE;
  return null;
}

/** Resolve links one component at a time; never stat a protected link target. */
export async function resolvePassiveProjectPath(path: string, options: ProjectScanPolicy = {}, signal?: AbortSignal): Promise<string | null | undefined> {
  let target = resolve(path);
  for (let links = 0; links < 40; links++) {
    if ((options.platform ?? process.platform) === 'darwin') {
      target = target.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/';
    }
    signal?.throwIfAborted();
    if (isPrivateProjectPath(target, options)) return null;
    const root = parse(target).root;
    const parts = target.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    let redirected = false;
    for (let i = 0; i < parts.length; i++) {
      signal?.throwIfAborted();
      current = join(current, parts[i]);
      if (isPrivateProjectPath(current, options)) return null;
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        signal?.throwIfAborted();
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return undefined;
        return null;
      }
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(current);
        target = resolve(dirname(current), link, ...parts.slice(i + 1));
        redirected = true;
        break;
      }
    }
    if (!redirected) return target;
  }
  return null;
}

export async function resolveProjectScanRoot(path: string, options: ProjectScanPolicy = {}, signal?: AbortSignal): Promise<string | null | undefined> {
  if (projectScanRestriction(path, options)) return null;
  const resolved = await resolvePassiveProjectPath(path, options, signal);
  if (!resolved) return resolved;
  return !projectScanRestriction(resolved, options) ? resolved : null;
}
