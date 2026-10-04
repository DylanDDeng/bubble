import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapesRoot } from '../../src/electron/libs/path-containment';
import { writeProjectEditorDraftSync } from '../../src/electron/libs/editor-draft-flush';

// Only a whole `..` segment leaves the root.
for (const rel of ['..', `..${path.sep}x`, `..${path.sep}..${path.sep}x`, path.resolve('/abs')]) {
  assert.equal(escapesRoot(rel), true, rel);
}
for (const rel of ['', 'a.md', '..notes.md', `..cache${path.sep}file`, `a${path.sep}..b`]) {
  assert.equal(escapesRoot(rel), false, rel);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-draft-flush-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-draft-outside-')));
try {
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  const write = (filePath: string, content: string) => writeProjectEditorDraftSync({ cwd: project, filePath, content });

  fs.writeFileSync(path.join(project, 'plain.md'), 'old');
  assert.equal(write('plain.md', 'new'), true);
  assert.equal(fs.readFileSync(path.join(project, 'plain.md'), 'utf8'), 'new');

  // In-project names that merely start with two dots are not outside.
  fs.writeFileSync(path.join(project, '..notes.md'), 'old');
  assert.equal(write('..notes.md', 'dots'), true);
  assert.equal(fs.readFileSync(path.join(project, '..notes.md'), 'utf8'), 'dots');

  // A symlinked document keeps its link; the real file receives the draft.
  fs.writeFileSync(path.join(project, 'docs', 'real.md'), 'old');
  fs.symlinkSync(path.join(project, 'docs', 'real.md'), path.join(project, 'link.md'));
  assert.equal(write('link.md', 'through link'), true);
  assert.equal(fs.lstatSync(path.join(project, 'link.md')).isSymbolicLink(), true, 'symlink survives');
  assert.equal(fs.readFileSync(path.join(project, 'docs', 'real.md'), 'utf8'), 'through link');

  // Nothing outside the project is written, by path or through a link.
  fs.writeFileSync(path.join(outside, 'secret.md'), 'keep');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'escape.md'));
  assert.equal(write('escape.md', 'pwned'), false);
  assert.equal(write(path.join('..', path.basename(outside), 'secret.md'), 'pwned'), false);
  assert.equal(write(path.join(outside, 'secret.md'), 'pwned'), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'keep');

  // Only existing editable text files.
  assert.equal(write('missing.md', 'x'), false);
  fs.writeFileSync(path.join(project, 'script.sh'), 'old');
  assert.equal(write('script.sh', 'x'), false);
  assert.equal(fs.readdirSync(project).filter((name) => name.endsWith('.tmp')).length, 0, 'no temp files left');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
console.log('path-containment tests passed');
