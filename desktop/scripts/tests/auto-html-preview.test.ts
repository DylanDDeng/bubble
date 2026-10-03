import assert from 'node:assert/strict';
import { autoPreviewHtmlArtifact } from '../../src/ui/utils/auto-html-preview';
import { openHtmlFileInBrowserTab, HtmlPreviewError } from '../../src/ui/utils/html-preview';

function fixture() {
  const calls: any[] = [], errors: unknown[] = [], opened: string[] = [];
  let current = true;
  let resolvePreview: (value: any) => void = () => {};
  (globalThis as any).window = { electron: {
    previewArtifactPath: (...args: any[]) => {
      calls.push(['preview', ...args]);
      return new Promise(resolve => { resolvePreview = resolve; });
    },
    browser: {
      getState: async (input: any) => { calls.push(['state', input]); return { tabs: [{ id: 'tab', url: 'old' }], activeTabId: 'tab' }; },
      navigate: async (input: any) => { calls.push(['navigate', input]); },
    },
  } };
  const pending = new Set(['a']), attempted = new Set<string>();
  const options = {
    sessionId: 'a', cwd: '/project/a', filePath: '/tmp/repro.html', toolUseId: 'write-1', pending, attempted,
    isCurrent: () => current,
    onOpened: () => { opened.push('a'); },
    onError: (error: unknown) => { errors.push(error); },
  };
  return { calls, errors, opened, pending, options, complete: (value: any) => resolvePreview(value), switchAway: () => { current = false; } };
}

async function main() {
  // Reproduce the reported out-of-project background artifact, followed by
  // repeated session switches. No repeated IPC and no unrelated error toast.
  {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    assert.equal(f.pending.size, 0, 'consume before IPC settles');
    f.complete({ ok: false, code: 'outside_project', message: 'File is outside the selected project folder' });
    await first;
    for (let i = 0; i < 20; i++) await autoPreviewHtmlArtifact(f.options);
    assert.equal(f.calls.length, 1);
    assert.equal(f.errors.length, 0);
    assert.equal(f.opened.length, 0);
  }
  // Re-running the watcher while IPC is pending must also remain one-shot.
  // The user's active session may switch away and back before the rejection.
  {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    for (let i = 0; i < 20; i++) await autoPreviewHtmlArtifact(f.options);
    assert.equal(f.calls.length, 1, 'only one request may be in flight per artifact');
    f.complete({ ok: false, code: 'outside_project', message: 'File is outside the selected project folder' });
    await first;
    assert.equal(f.pending.size, 0);
    assert.equal(f.errors.length, 0);
  }
  // An older rejection must neither clear nor deduplicate the next artifact.
  {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    f.complete({ ok: false, code: 'outside_project', message: 'outside' });
    f.pending.add('a');
    const next = autoPreviewHtmlArtifact({ ...f.options, toolUseId: 'write-2', filePath: '/project/a/new.html' });
    await first;
    f.complete({ ok: true, url: 'http://127.0.0.1/new' });
    await next;
    assert.equal(f.calls.filter(call => call[0] === 'preview').length, 2);
    assert.deepEqual(f.opened, ['a']);
    assert.equal(f.errors.length, 0);
  }
  // A real failure is visible once for the current session; tab switches
  // cannot turn it into a retry loop either.
  {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    f.complete({ ok: false, message: 'Preview file was not found' }); await first;
    await autoPreviewHtmlArtifact(f.options);
    assert.equal(f.errors.length, 1);
    assert.equal(f.calls.length, 1);
  }
  for (const success of [true, false]) {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    f.switchAway();
    f.pending.add('a'); // A newer turn can finish while old IPC is pending.
    f.complete(success ? { ok: true, url: 'http://127.0.0.1/fixture' } : { ok: false, message: 'failed' });
    await first;
    assert(f.pending.has('a'), 'old completion must not consume a newer turn');
    assert.equal(f.opened.length, 0, 'old session cannot reveal current browser panel');
    assert.equal(f.errors.length, 0, 'old session cannot toast in new session');
    if (success) assert.deepEqual(f.calls.at(-1), ['navigate', { sessionId: 'a', url: 'http://127.0.0.1/fixture' }]);
  }
  {
    const f = fixture();
    const first = autoPreviewHtmlArtifact(f.options);
    f.complete({ ok: true, url: 'http://127.0.0.1/first' }); await first;
    assert.deepEqual(f.opened, ['a']);
    const next = autoPreviewHtmlArtifact({ ...f.options, toolUseId: 'write-2' });
    f.complete({ ok: true, url: 'http://127.0.0.1/second' }); await next;
    assert.equal(f.opened.length, 2, 'a new artifact still opens normally');
  }
  {
    const f = fixture();
    const manual = openHtmlFileInBrowserTab(f.options);
    const rejected = assert.rejects(manual, error => error instanceof HtmlPreviewError && error.code === 'outside_project');
    f.complete({ ok: false, code: 'outside_project', message: 'File is outside the selected project folder' });
    await rejected; // Explicit user opens still surface the validation failure.
  }
  console.log('PASS: rejected auto-preview + 20 switches, in-flight deduplication, one-shot failures, async session/turn races, new artifacts, explicit-open errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
