import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function expandHomePath(value: unknown): string {
  const text = String(value ?? "");
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return join(homedir(), text.slice(2));
  }
  return text;
}

export function resolveToolPath(cwd: string, value: unknown, fallback = "."): string {
  const text = String(value ?? "");
  const path = text === "" ? fallback : text;
  return resolve(cwd, expandHomePath(path));
}

/**
 * Where a path really leads once symlinks are followed — including links in
 * its parent directories and dangling links (writing through a dangling link
 * creates its target). Parts that do not exist yet are kept as written.
 */
export function resolveThroughLinks(path: string): string {
  return followLinks(path, 0);
}

function followLinks(path: string, depth: number): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      // Missing (or dangling): follow a dangling link, else step up.
    }
    if (depth < 16) {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          const target = resolve(dirname(current), readlinkSync(current));
          return followLinks(join(target, ...rest), depth + 1);
        }
      } catch {
        // Not there at all.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.unshift(basename(current));
    current = parent;
  }
}
