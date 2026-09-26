import assert from 'node:assert/strict';
import { buildPromptText, LONG_PROMPT_ATTACHMENT_INSTRUCTION } from '../../src/electron/libs/provider/bubble-prompt-text';
import type { Attachment } from '../../src/shared/types';

const pasted = (text: string, id = 'p1'): Attachment => ({
  id, kind: 'file', name: `prompt-${id}.txt`, path: `/tmp/aegis-pasted-text/prompt-${id}.txt`,
  mimeType: 'text/plain', size: text.length, uiType: 'pasted_text', previewText: text,
});
const file: Attachment = { id: 'f1', kind: 'file', name: 'notes.md', path: '/repo/notes.md', mimeType: 'text/markdown', size: 10 };
const image: Attachment = { id: 'i1', kind: 'image', name: 'shot.png', path: '/tmp/shot.png', mimeType: 'image/png', size: 10 };

const long = '请使用 Three.js + HTML + CSS 开发一个可直接打开的页面。'.repeat(40);

// Paste chip + typed follow-up: the model reads the pasted words first, then the typed ones. No path, no file name.
assert.equal(buildPromptText('完成这个任务：直接写成一个HTML文档', [pasted(long)]), `${long}\n\n完成这个任务：直接写成一个HTML文档`);
assert(!buildPromptText('x', [pasted(long)]).includes('aegis-pasted-text'), 'temp file path never reaches the model');
assert(!buildPromptText('x', [pasted(long)]).includes('Attachments:'), 'pasted text is not an attachment list');

// Long prompt converted at send time: the placeholder is dropped, only the user's words remain.
assert.equal(buildPromptText(LONG_PROMPT_ATTACHMENT_INSTRUCTION, [pasted(long)]), long);

// The placeholder is only dropped when it stands in for pasted text.
assert.equal(buildPromptText(LONG_PROMPT_ATTACHMENT_INSTRUCTION, [file]),
  `${LONG_PROMPT_ATTACHMENT_INSTRUCTION}\n\nAttachments:\n- notes.md: /repo/notes.md`);

// Real files still travel by path; images are handled as parts elsewhere.
assert.equal(buildPromptText('look', [file, image]), 'look\n\nAttachments:\n- notes.md: /repo/notes.md');
assert.equal(buildPromptText('look', [pasted('first', 'a'), file, pasted('second', 'b')]),
  'first\n\nsecond\n\nlook\n\nAttachments:\n- notes.md: /repo/notes.md');

// Unchanged plain sends.
assert.equal(buildPromptText('hello', []), 'hello');
assert.equal(buildPromptText('hello', undefined), 'hello');
assert.equal(buildPromptText('', [pasted('only pasted')]), 'only pasted');

console.log('PASS: pasted text is inlined as the user\'s words; real files keep their paths');
