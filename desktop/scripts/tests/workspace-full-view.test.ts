import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as tabs from '../../src/ui/utils/right-utility-tabs';

async function main() {
  // Exercise actual store actions without bootstrapping unrelated provider IPC.
  const source = await readFile(new URL('../../src/ui/store/useAppStore.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['setRightPanelFullscreen', 'setActiveRightUtilityTab', 'openRightUtilityTab', 'closeRightUtilityTab'];
  const actions = new Map<string, ts.Expression>();
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && names.includes(node.name.getText(tree))) actions.set(node.name.getText(tree), node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  let state: any = {
    rightPanelFullscreen: null, rightUtilityTabs: ['files:first', 'files:second', 'browser:a'],
    activeRightUtilityTab: 'files:second', rightUtilityPanelHidden: false,
  };
  const context = vm.createContext({
    ...tabs, get: () => state,
    set: (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
  });
  for (const name of names) {
    assert.ok(actions.get(name), name);
    vm.runInContext(ts.transpileModule(`globalThis.${name} = (${actions.get(name)!.getText(tree)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
  }
  context.setRightPanelFullscreen('files');
  assert.equal(state.activeRightUtilityTab, 'files:second', 'full view keeps the selected document');
  context.setActiveRightUtilityTab('browser:a');
  assert.equal(state.rightPanelFullscreen, 'browser', 'tab selection carries full view to browser');
  context.openRightUtilityTab('review');
  assert.equal(state.rightPanelFullscreen, 'review', 'opening Changes carries full view');
  context.setRightPanelFullscreen('review');
  assert.equal(state.rightPanelFullscreen, 'review', 'Changes supports full view');
  context.closeRightUtilityTab('files:first');
  assert.equal(state.rightPanelFullscreen, 'review', 'closing a background tab does not exit full view');
  context.closeRightUtilityTab('review');
  assert.equal(state.rightPanelFullscreen, 'browser', 'closing active tab transfers full view to its neighbor');
  context.setRightPanelFullscreen(null);
  context.openRightUtilityTab('files');
  assert.equal(state.rightPanelFullscreen, null, 'ordinary navigation does not enter full view');
  context.setRightPanelFullscreen('files');
  context.openRightUtilityTab('terminal');
  assert.equal(state.rightPanelFullscreen, null, 'tools without full view return to split');
  console.log('workspace full view: document identity, tool switches, Changes, background/active close and split return passed');

}
void main();
