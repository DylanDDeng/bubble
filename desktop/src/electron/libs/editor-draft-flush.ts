import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapesRoot } from './path-containment';

const EDITABLE_PROJECT_EDITOR_EXTENSIONS = new Set(['.txt', '.md', '.mdx']);

/**
 * Close/quit fallback for an unsaved editor draft: synchronously writes an
 * existing editable text file inside the project root. Returns whether it wrote.
 */
export function writeProjectEditorDraftSync(draft: { cwd: string; filePath: string; content: string }): boolean {
  const root = path.resolve(draft.cwd || '.');
  const resolved = path.resolve(root, draft.filePath || '');
  const ext = path.extname(resolved).toLowerCase();
  if (!EDITABLE_PROJECT_EDITOR_EXTENSIONS.has(ext)) return false;
  if (escapesRoot(path.relative(root, resolved))) return false;
  if (!fs.existsSync(resolved)) return false;
  // Write through the real target, like the async save: renaming onto the
  // lexical path would replace a symlinked document with a regular file.
  const target = fs.realpathSync(resolved);
  if (escapesRoot(path.relative(fs.realpathSync(root), target))) return false;
  const stat = fs.statSync(target);
  if (!stat.isFile()) return false;
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, draft.content ?? '', { encoding: 'utf8', mode: stat.mode });
    fs.renameSync(tempPath, target);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failures
    }
  }
  return true;
}
