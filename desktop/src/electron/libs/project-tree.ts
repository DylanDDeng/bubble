import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { basename, join, sep } from 'path';
import type { ProjectTreeNode } from '../types';

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'dist-react',
  '.dev-sdk-build',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.cache',
  '.vite',
  '.idea',
  '.worktrees',
]);

export function isIgnoredProjectTreeChange(relativePath: string): boolean {
  // Only ancestors are known to be directories. The leaf may be a visible
  // file named "build", or a deleted/renamed entry whose type is no longer known.
  return relativePath.split(sep).slice(0, -1).some(part => IGNORED_DIRECTORY_NAMES.has(part));
}

async function buildNode(fullPath: string, name: string, signal?: AbortSignal): Promise<ProjectTreeNode> {
  signal?.throwIfAborted();
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch {
    signal?.throwIfAborted();
    return { name, path: fullPath, kind: 'file' };
  }
  signal?.throwIfAborted();

  if (!stat.isDirectory()) {
    return { name, path: fullPath, kind: 'file' };
  }

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(fullPath, { withFileTypes: true });
  } catch {
    signal?.throwIfAborted();
    return { name, path: fullPath, kind: 'dir', children: [] };
  }
  signal?.throwIfAborted();

  const children: ProjectTreeNode[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const childPath = join(fullPath, entry.name);
    if (entry.isDirectory()) {
      children.push(await buildNode(childPath, entry.name, signal));
    } else {
      children.push({ name: entry.name, path: childPath, kind: 'file' });
    }
  }

  return { name, path: fullPath, kind: 'dir', children };
}

export async function readProjectTree(rootPath: string, signal?: AbortSignal): Promise<ProjectTreeNode | null> {
  signal?.throwIfAborted();
  let stat;
  try {
    stat = await fs.stat(rootPath);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  signal?.throwIfAborted();
  if (!stat.isDirectory()) {
    return null;
  }

  const name = basename(rootPath) || rootPath;
  return buildNode(rootPath, name, signal);
}
