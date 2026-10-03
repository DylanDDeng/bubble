import assert from "node:assert/strict";
import { DesignUndo, blockedBy, touchedBoards, undoKey } from "../../src/ui/components/design/design-undo";

const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
// Platform conventions.
assert.equal(undoKey(k("z", { metaKey: true }), true), "undo");
assert.equal(undoKey(k("Z", { metaKey: true, shiftKey: true }), true), "redo");
assert.equal(undoKey(k("z", { ctrlKey: true }), true), undefined, "Ctrl+Z is not undo on macOS");
assert.equal(undoKey(k("z", { ctrlKey: true }), false), "undo");
assert.equal(undoKey(k("y", { ctrlKey: true }), false), "redo");
assert.equal(undoKey(k("z", { ctrlKey: true, shiftKey: true }), false), "redo");
assert.equal(undoKey(k("z", { metaKey: true }), false), undefined, "Win key is not undo elsewhere");
assert.equal(undoKey(k("z"), true), undefined);

assert.deepEqual(
  touchedBoards(
    [
      { type: "placement", boardId: "a", expectedRevision: 1, x: 3 },
      { type: "add", name: "New" },
    ],
    [{ id: "a" }, { id: "b" }],
    [{ id: "a" }, { id: "b" }, { id: "c" }],
  ),
  ["a", "c"],
);

const entry = { from: 4, to: 5, boardIds: ["a"], title: false, summary: "Moved Home" };
const row = (revision: number, boardIds: string[]) => ({ revision, createdAt: 0, author: null, summary: null, commentId: null, boardIds });
assert.equal(blockedBy(entry, [row(6, ["b"]), row(5, ["a"])]), false, "other boards do not block");
assert.equal(blockedBy(entry, [row(6, ["a"])]), true, "a later change to the same board blocks");

const stack = new DesignUndo();
stack.record(entry);
stack.redo.push(entry);
stack.record({ ...entry, from: 5, to: 6 });
assert.equal(stack.redo.length, 0, "a new edit clears redo");
console.log("Design undo: platform keys, touched boards, conflicts and stack rules passed");
