import { isAbsolute, sep } from 'node:path';

/**
 * Whether a `path.relative(root, target)` result leaves `root`. Only `..` as a
 * whole segment climbs out: `..notes.md` and `..cache/x` are in-project names.
 */
export function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
