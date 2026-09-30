import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRightUtilityTabOpen, resolveProjectFileUtilityTab } from '../../src/ui/utils/right-utility-tabs';
import { resolveDockedRightPanelWidth } from '../../src/ui/utils/right-panel-width';

async function main() {
  assert.equal(
    resolveDockedRightPanelWidth(820, 560),
    320,
    'a desktop-sized panel must remain docked at the right of the minimum window'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 692),
    340,
    'compact windows must preserve a visible conversation pane'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 1600),
    820,
    'wide windows must preserve the saved panel width'
  );
  assert.equal(
    resolveDockedRightPanelWidth(1500, 2000),
    1500,
    'large windows can use more than 58 percent without crowding the conversation'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 280),
    280,
    'a host narrower than the panel minimum must not overflow'
  );

  const first = resolveRightUtilityTabOpen([], 'files', { newTab: true });
  assert.equal(first.tabs.length, 1);
  assert.equal(first.activeTab, first.tabs[0]);
  assert.match(first.activeTab, /^files:/);

  const second = resolveRightUtilityTabOpen(first.tabs, 'files', { newTab: true });
  assert.equal(second.tabs.length, 2, 'Files from the plus menu must append another tab');
  assert.notEqual(second.activeTab, first.activeTab, 'the new Files tab must have its own identity');
  assert.equal(second.activeTab, second.tabs[1], 'the new Files tab must become active');

  const existing = resolveRightUtilityTabOpen(second.tabs, 'files');
  assert.deepEqual(existing.tabs, second.tabs, 'ordinary Files navigation should reuse a tab');
  assert.equal(existing.activeTab, first.activeTab);

  const fileStates = {
    [first.activeTab]: { files: [], activeFile: { cwd: '/project', filePath: '/project/a.md' } },
    [second.activeTab]: { files: [], activeFile: { cwd: '/project', filePath: '/project/b.png' } },
  };
  assert.equal(resolveProjectFileUtilityTab(second.tabs, second.activeTab, fileStates, '/project/a.md').activeTab, first.activeTab);
  assert.equal(resolveProjectFileUtilityTab(second.tabs, second.activeTab, fileStates, '/project/b.png').activeTab, second.activeTab);
  const legacy = { [first.activeTab]: {
    activeFile: { cwd: '/project', filePath: '/project/a.md' },
    files: [{ cwd: '/project', filePath: '/project/a.md' }, { cwd: '/project', filePath: '/project/hidden.md' }],
  } };
  assert.equal(resolveProjectFileUtilityTab(first.tabs, first.activeTab, legacy, '/project/hidden.md').tabs.length, 2,
    'legacy hidden inner tabs must not replace a different visible document');
  const third = resolveProjectFileUtilityTab(second.tabs, second.activeTab, fileStates, '/elsewhere/a.md');
  assert.equal(third.tabs.length, 3, 'same basename in another directory is a distinct file');
  const empty = resolveRightUtilityTabOpen(second.tabs, 'files', { newTab: true });
  assert.equal(resolveProjectFileUtilityTab(empty.tabs, empty.activeTab, fileStates, '/project/new.pdf').activeTab, empty.activeTab,
    'an explicitly opened empty Files tab can host the next document');
  assert.equal(resolveProjectFileUtilityTab(['browser'], 'browser', fileStates, '/project/a.md').tabs.length, 2,
    'closed file identities cannot resurrect a removed tab');

  const appSource = await readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8');
  assert.match(
    appSource,
    /deriveSubagentSummaries\(activeSession\?\.messages \?\? \[\], \{ includeNested: true \}\)[\s\S]*?\.map\(summary => \[summary\.id, summary\.persona\]\)[\s\S]*?\[activeSession\?\.messages\]/,
    'tab identities must use the same nested-aware, reactive session summaries as the detail panel'
  );
  assert.match(appSource, /subagentPersonas\.get\(subagentId\) \?\? getSubagentPersona\(subagentId\)/,
    'legacy ID naming is only a fallback when the summary is unavailable');
  assert.match(appSource, /label: persona\?\.persona \?\? 'Subagent',\s*subagentPersona: persona/,
    'tab label and avatar must receive the same resolved identity');
  assert.match(appSource, /rightUtilityTabs,\s*subagentPersonas,\s*\]\)/,
    'open tab descriptors must update when runtime names arrive or history changes');
  assert.match(appSource, /id=\{tab\.subagentPersona\.id\}\s*hue=\{tab\.subagentPersona\.colorHue\}/,
    'tab avatars must use the detail persona ID and hue, not the routing tool ID');
  assert.doesNotMatch(appSource, /getSubagentPersona\(tab\.subagentId\)/,
    'the tab renderer must not regenerate an independent identity');

  // Tabs must open via onSelect (click completion) so Base UI still closes
  // the popup itself. Firing on pointerdown reflows the tab strip mid-press,
  // the popup re-anchors, and the release no longer counts as an item click,
  // leaving the menu stuck open.
  assert.match(
    appSource,
    /onSelect=\{\(\) =>\s*onOpenTab\(/,
    'the plus menu must open tabs on select, not pointerdown'
  );
  assert.doesNotMatch(
    appSource,
    /onPointerDown=\{[\s\S]{0,200}?onOpenTab\(/,
    'opening tabs on pointerdown leaves the plus menu stuck open'
  );
  assert.match(
    appSource,
    /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/,
    'a newly active utility tab must be scrolled into view'
  );
  assert.match(
    appSource,
    /onOpenChange=\{onNativeOverlayChange\}/,
    'the plus menu must suspend the native browser view while open'
  );
  assert.match(
    appSource,
    /useBrowserNativeOverlayRegistration\(nativeOverlayOpen\)/,
    'the plus menu must register with the shared native-view overlay manager'
  );
  assert.match(
    appSource,
    /BrowserNativeOverlayContext\.Provider value=\{browserNativeOverlayContextValue\}/,
    'app-level overlays must publish shared native-view visibility to BrowserPanel'
  );

  const panelSource = await readFile(
    new URL('../../src/ui/components/browser/BrowserPanel.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    panelSource,
    /nativeViewHidden = collapsed \|\| overlayOpen/,
    'BrowserPanel must hide the WebContentsView while an HTML overlay is open'
  );
  assert.match(
    panelSource,
    /useLayoutEffect\(\(\) => \{[\s\S]*?visibleBrowserSessionRef\.current = null;[\s\S]*?browser\.hide\([\s\S]*?if \(nativeViewHidden\) hide\(\);\s*return hide;/,
    'collapsing a browser tab must detach the native view before the next paint'
  );

  const attachmentPreviewSource = await readFile(
    new URL('../../src/ui/components/AttachmentPreviewGrid.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    attachmentPreviewSource,
    /useBrowserNativeOverlayRegistration\(lightboxOpen\)/,
    'the attachment lightbox must hide the native browser view while open'
  );

  console.log('right-utility-tabs tests passed');
}

void main();
