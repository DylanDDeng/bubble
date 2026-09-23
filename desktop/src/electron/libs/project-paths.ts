import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function canonicalProjectPath(path: string): string {
  return canonicalize(path, 0);
}

function canonicalize(path: string, depth: number): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing); } catch {
      // A dangling link still decides where a write lands: follow it.
      if (depth < 16) {
        try {
          if (lstatSync(current).isSymbolicLink()) {
            return canonicalize(join(resolve(dirname(current), readlinkSync(current)), ...missing), depth + 1);
          }
        } catch { /* not there at all */ }
      }
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function isWithinProjectPath(path: string, root: string): boolean {
  const rel = relative(canonicalProjectPath(root), canonicalProjectPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function missingProjectSources(source: string[], target: string[]): string[] {
  return [...new Set(source.map(canonicalProjectPath))]
    .filter(path => !target.some(root => isWithinProjectPath(path, root)));
}
