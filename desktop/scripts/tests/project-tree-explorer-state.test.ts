import assert from 'node:assert/strict';
import {
  getProjectTreeAncestorDirs,
  getProjectTreeExplorerKey,
  getProjectTreeExplorerScrollTop,
  getProjectTreeExplorerState,
  resetProjectTreeExplorerStatesForTests,
  setProjectTreeExplorerScrollTop,
  subscribeProjectTreeExplorerState,
  updateProjectTreeExplorerState,
} from '../../src/ui/utils/project-tree-explorer-state';

const root = '/Users/me/site';

// Absolute file paths expand every directory below the root, not "Users/me/...".
assert.deepEqual(getProjectTreeAncestorDirs(root, `${root}/content/newbie/a.md`), [
  `${root}/content/newbie`,
  `${root}/content`,
]);
assert.deepEqual(getProjectTreeAncestorDirs(root, `${root}/README.md`), []);
assert.deepEqual(getProjectTreeAncestorDirs(root, '/elsewhere/a.md'), []);
assert.deepEqual(getProjectTreeAncestorDirs(`${root}/`, `${root}/docs/a.md`), [`${root}/docs`]);
assert.deepEqual(getProjectTreeAncestorDirs('C:\\proj', 'C:\\proj\\src\\a.ts'), ['C:\\proj\\src']);

// Two Files tabs of one session share the explorer; another session does not.
resetProjectTreeExplorerStatesForTests();
const tabA = getProjectTreeExplorerKey('session-1', root);
const tabB = getProjectTreeExplorerKey('session-1', root);
const otherSession = getProjectTreeExplorerKey('session-2', root);
let notifications = 0;
subscribeProjectTreeExplorerState(() => {
  notifications += 1;
});

assert.equal(getProjectTreeExplorerState(tabA), null);
updateProjectTreeExplorerState(tabA, root, (current) => ({
  ...current,
  expandedPaths: new Set([...current.expandedPaths, `${root}/content`]),
}));
assert.deepEqual([...getProjectTreeExplorerState(tabB)!.expandedPaths], [root, `${root}/content`]);
assert.equal(getProjectTreeExplorerState(otherSession), null);
assert.equal(notifications, 1);

// No-op updates keep the snapshot identity and do not notify.
const snapshot = getProjectTreeExplorerState(tabA);
updateProjectTreeExplorerState(tabA, root, (current) => current);
assert.equal(getProjectTreeExplorerState(tabA), snapshot);
assert.equal(notifications, 1);

setProjectTreeExplorerScrollTop(tabA, 420);
assert.equal(getProjectTreeExplorerScrollTop(tabB), 420);
assert.equal(getProjectTreeExplorerScrollTop(otherSession), 0);
assert.equal(notifications, 1);

console.log('project-tree-explorer-state tests passed');
