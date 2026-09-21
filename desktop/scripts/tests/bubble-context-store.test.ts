import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { useAppStore as store } from '../../src/ui/store/useAppStore';
import type { CompactMetadata, StreamMessage } from '../../src/shared/types';

const notices: string[] = [];
const originalSuccess = toast.success;
toast.success = ((message: unknown) => { notices.push(String(message)); return notices.length; }) as typeof toast.success;

function seed(id: string, provider = 'bubble', hiddenFromThreads = false) {
  store.setState(state => ({ activeSessionId: id, sessions: { ...state.sessions, [id]: {
    id, title: id, provider, hiddenFromThreads, status: 'running', hydrated: true, messages: [],
    permissionRequests: [], streaming: { text: '', thinking: '', isStreaming: false },
  } } as never }));
}
function boundary(id: string, metadata: Partial<CompactMetadata> = {}, extra: object = {}): StreamMessage {
  return { type: 'system', subtype: 'compact_boundary', session_id: 'provider-session', uuid: `uuid-${id}`,
    compactMetadata: { trigger: 'auto', preTokens: 240000, postTokens: 30000, compactionId: id, persisted: true, ...metadata }, ...extra };
}
function live(sessionId: string, message: StreamMessage) {
  store.getState().handleServerEvent({ type: 'stream.message', payload: { sessionId, message } });
}
function history(sessionId: string, messages: StreamMessage[]) {
  store.getState().handleServerEvent({ type: 'session.history', payload: { sessionId, status: 'idle', messages } });
}
function silent(action: () => void, label: string) {
  const count = notices.length;
  action();
  assert.equal(notices.length, count, label);
}

async function main() {
  try {
    seed('main');
    live('main', boundary('success'));
    assert.deepEqual(notices, ['Bubble auto-compacted the conversation context (240,000 → 30,000 tokens).']);
    silent(() => {
      live('main', boundary('success'));
      live('main', boundary('success', {}, { uuid: 'different-transport-uuid' }));
    }, 'deduplicates by checkpoint, not transport UUID');

    silent(() => {
      history('main', [boundary('history')]);
      assert.equal(store.getState().sessions.main.messages[0].type, 'system');
      live('main', boundary('history', {}, { uuid: 'history-replay' }));
      history('main', []);
      live('main', boundary('history', {}, { uuid: 'after-history-replacement' }));
    }, 'history is visible but never toasts, including replays after replacement');

    seed('background');
    store.setState({ activeSessionId: 'main' });
    silent(() => {
      live('background', boundary('background-success'));
      store.setState({ activeSessionId: 'background' });
      live('background', boundary('background-success', {}, { uuid: 'foreground-replay' }));
    }, 'background receipt stays consumed after switching to foreground');

    seed('hidden', 'bubble', true);
    silent(() => live('hidden', boundary('hidden-success')), 'hidden execution sessions never toast');
    seed('parent');
    silent(() => live('parent', boundary('child-success', {}, { parentToolUseId: 'task-1' })), 'subagent boundaries never toast');
    silent(() => live('parent', boundary('manual', { trigger: 'manual' })), 'manual compaction does not receive an automatic toast');
    silent(() => {
      live('parent', boundary('unpersisted', { persisted: false }));
      live('parent', boundary('legacy', { persisted: undefined, compactionId: undefined }));
      for (const status of ['started', 'failed'] as const) {
        live('parent', { type: 'system', subtype: 'compact_status', uuid: status, session_id: 'parent', status, trigger: 'auto' });
      }
    }, 'started, failed, unpersisted and old SDK completions never toast');
    const beforeCommit = notices.length;
    live('parent', boundary('unpersisted'));
    assert.equal(notices.length, beforeCommit + 1, 'a later reliable completion can notify');
    live('parent', boundary('no-counts', { postTokens: undefined }));
    assert.equal(notices.at(-1), 'Bubble auto-compacted the conversation context.');

    seed('another-session');
    const beforeOther = notices.length;
    live('another-session', boundary('success'));
    assert.equal(notices.length, beforeOther + 1, 'checkpoint keys are scoped to desktop session');

    // Older-page hydration is a separate store path from session.history.
    seed('older');
    store.setState(state => ({ sessions: { ...state.sessions, older: {
      ...state.sessions.older, hasMoreHistory: true, historyCursor: 'page-2',
    } } }));
    (globalThis as any).window = { electron: { loadOlderSessionHistory: async () => ({ messages: [boundary('older-page')], hasMore: false }) } };
    store.getState().loadOlderSessionHistory('older');
    await new Promise(resolve => setTimeout(resolve, 0));
    silent(() => live('older', boundary('older-page', {}, { uuid: 'older-replay' })), 'older history pages also consume notification receipts');
    delete (globalThis as any).window;

    for (const provider of ['claude', 'codex']) {
      seed(provider, provider);
      const count = notices.length;
      live(provider, boundary(`${provider}-auto`, { persisted: undefined, compactionId: undefined }));
      assert.equal(notices.length, count + 1, `${provider} retains its existing auto-compaction toast`);
      assert.equal(notices.at(-1), `${provider === 'claude' ? 'Claude' : 'Codex'} auto-compacted the conversation context.`);
      silent(() => live(provider, boundary(`${provider}-manual`, { trigger: 'manual' })), `${provider} manual behavior is unchanged`);
    }
    console.log('PASS: live store compaction notifications cover success, replay, history, background, hidden, subagent, manual, failure and persistence');
  } finally {
    toast.success = originalSuccess;
    delete (globalThis as any).window;
  }
}
void main();
