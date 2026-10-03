/**
 * Explorer chrome (expanded folders, filter, scroll offset) shared by every
 * Files tab of one session + workspace root.
 *
 * Each outer Files tab owns a single document, so opening a second file from
 * the tree mounts a brand-new ProjectTreePanel. Keeping the explorer state
 * here instead of in component state lets that new tab show the tree exactly
 * as the user left it, and keeps already-mounted tabs in sync.
 */

export type ProjectTreeExplorerState = {
  expandedPaths: Set<string>;
  filter: string;
};

const MAX_EXPLORER_STATES = 64;
const states = new Map<string, ProjectTreeExplorerState>();
// Scroll changes on every wheel tick; keep it out of the subscribed snapshot.
const scrollTops = new Map<string, number>();
const listeners = new Set<() => void>();

export function getProjectTreeExplorerKey(sessionKey: string, rootPath: string): string {
  return `${sessionKey}::${rootPath}`;
}

export function subscribeProjectTreeExplorerState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProjectTreeExplorerState(key: string | null): ProjectTreeExplorerState | null {
  return key ? states.get(key) ?? null : null;
}

export function createDefaultProjectTreeExplorerState(rootPath: string): ProjectTreeExplorerState {
  return { expandedPaths: new Set([rootPath]), filter: '' };
}

export function updateProjectTreeExplorerState(
  key: string,
  rootPath: string,
  updater: (current: ProjectTreeExplorerState) => ProjectTreeExplorerState
): void {
  const current = states.get(key) ?? createDefaultProjectTreeExplorerState(rootPath);
  const next = updater(current);
  if (next === current && states.has(key)) return;
  states.delete(key);
  states.set(key, next);
  if (states.size > MAX_EXPLORER_STATES) {
    const oldestKey = states.keys().next().value;
    if (oldestKey !== undefined) {
      states.delete(oldestKey);
      scrollTops.delete(oldestKey);
    }
  }
  for (const listener of listeners) listener();
}

export function getProjectTreeExplorerScrollTop(key: string | null): number {
  return key ? scrollTops.get(key) ?? 0 : 0;
}

export function setProjectTreeExplorerScrollTop(key: string, scrollTop: number): void {
  scrollTops.set(key, scrollTop);
}

/**
 * Directories between `rootPath` (exclusive) and `filePath`, nearest first,
 * spelled with the file path's own separators so they match tree node paths.
 */
export function getProjectTreeAncestorDirs(rootPath: string, filePath: string): string[] {
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  };
  const root = normalize(rootPath);
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const ancestors: string[] = [];
  let dir = filePath;
  while (true) {
    const index = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    if (index <= 0) break;
    dir = dir.slice(0, index);
    if (!normalize(dir).startsWith(rootPrefix)) break;
    ancestors.push(dir);
  }
  return ancestors;
}

export function resetProjectTreeExplorerStatesForTests(): void {
  states.clear();
  scrollTops.clear();
  listeners.clear();
}
