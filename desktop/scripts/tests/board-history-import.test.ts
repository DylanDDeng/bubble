import assert from 'node:assert/strict';
import { materializeSessions, useBoardStore } from '../../src/ui/store/useBoardStore';
import type { SessionView } from '../../src/ui/types';

useBoardStore.setState({ tasks: {}, excludedSessionIds: {} });
const history = { id: 'history', title: 'Old conversation', status: 'idle', source: 'bubble_imported', provider: 'bubble', createdAt: 1000, updatedAt: 2000 } as SessionView;
const fresh = { ...history, id: 'fresh', source: 'bubble_local' } as SessionView;
materializeSessions({ history, fresh });
const tasks = Object.values(useBoardStore.getState().tasks);
const imported = tasks.find(task => task.sessionIds.includes('history'))!;
assert.equal(imported.stage, 'review', 'old histories are not new work or claimed successes');
assert.equal(imported.createdAt, 1000);
assert.equal(imported.updatedAt, 2000);
assert.equal(tasks.find(task => task.sessionIds.includes('fresh'))!.stage, 'todo');
useBoardStore.getState().setStage(imported.id, 'done');
materializeSessions({ history });
assert.equal(useBoardStore.getState().tasks[imported.id].stage, 'done', 'later hydration preserves user placement');
assert.equal(Object.keys(useBoardStore.getState().tasks).length, 2);
console.log('PASS: imported board stage, original dates, and user-owned placement');
