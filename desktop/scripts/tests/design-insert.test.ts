import assert from "node:assert/strict";
import { frameStyle, snapBoard, textTagFor } from "../../src/ui/components/design/design-insert";

// New text follows nearby text, else a paragraph; a list gets a list item.
assert.equal(textTagFor({ containerTag: "main", nearTag: "p", direction: "stack" }), "p");
assert.equal(textTagFor({ containerTag: "main", nearTag: "h1", direction: "stack" }), "p", "not another headline");
assert.equal(textTagFor({ containerTag: "nav", nearTag: "button", direction: "row" }), "span");
assert.equal(textTagFor({ containerTag: "ul", nearTag: "li", direction: "stack" }), "li");
assert.equal(textTagFor({ containerTag: "div", nearTag: "small", direction: "row" }), "small");

assert.equal(
  frameStyle(340.4, 200),
  "display: flex; flex-direction: column; gap: 12px; padding: 16px; width: 340px; height: 200px; flex-shrink: 0",
);
assert(frameStyle(100, 100, { x: 12.6, y: 30 }).startsWith("position: absolute; left: 13px; top: 30px;"));

// New boards snap to device widths (and heights when close), from the press point.
const a = { x: 1000, y: 0 };
let s = snapBoard(a, { x: 1000, y: 0, width: 402, height: 850 }, 16);
assert.deepEqual(s.rect, { x: 1000, y: 0, width: 390, height: 844 });
assert.equal(s.label, "390 × 844 · Phone ✓");
s = snapBoard(a, { x: 600, y: 0, width: 400, height: 500 }, 16);
assert.deepEqual(s.rect, { x: 610, y: 0, width: 390, height: 500 }, "dragged left: anchored at the press point");
s = snapBoard(a, { x: 1000, y: 0, width: 40, height: 9000 }, 16);
assert.deepEqual([s.rect.width, s.rect.height, s.label], [100, 4096, "100 × 4096"], "within board limits");
console.log("Design insert: text tags, frame styles and board snapping passed");
