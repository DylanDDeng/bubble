import assert from 'node:assert/strict';
import { zoomAt, toWorld, fitView, resizeRect, snapMove, intersects } from '../../src/ui/components/design/canvas-geometry';
for (const zoom of [.02, .06, .3, 1, 4]) {
  const view = { x: -370, y: 230, zoom }, cursor = { x: 433, y: 176 }, before = toWorld(cursor, view);
  for (const target of [.001, .12, 1, 9]) {
    const next = zoomAt(view, cursor, target), after = toWorld(cursor, next);
    assert(Math.abs(before.x - after.x) < 1e-8 && Math.abs(before.y - after.y) < 1e-8, 'zoom preserves the world point under the cursor');
    assert(next.zoom >= .02 && next.zoom <= 4);
  }
}
const all = fitView([{ x: -300, y: -100, width: 32000, height: 4096 }], { width: 1000, height: 700 })!;
assert(all.zoom < .06, 'large canvases fit below the old 15% minimum');
assert.equal(fitView([], { width: 100, height: 100 }), undefined);
const r = { x: 50, y: 80, width: 800, height: 600 };
const min = resizeRect(r, 'nw', 1000, 1000, false);
assert.deepEqual(min, { x: 750, y: 580, width: 100, height: 100 });
assert.equal(min.x + min.width, r.x + r.width, 'opposite resize corner stays fixed');
const proportional = resizeRect(r, 'se', 400, 5, true);
assert.equal(proportional.width / proportional.height, r.width / r.height);
assert.equal(resizeRect(r, 'e', 9000, 0, false).width, 4096);
const snapped = snapMove({ x: 995, y: 201, width: 200, height: 100 }, [{ x: 1000, y: 200, width: 300, height: 200 }], 1);
assert.equal(snapped.dx, 5); assert.equal(snapped.dy, -1);
assert.equal(snapMove({ x: 995, y: 201, width: 200, height: 100 }, [{ x: 1000, y: 200, width: 300, height: 200 }], 4).dx, 0, 'snap distance is in screen pixels');
assert(intersects(r, { x: 800, y: 500, width: 100, height: 300 }));
assert(!intersects(r, { x: -300, y: -200, width: 100, height: 50 }));
console.log('Canvas geometry: anchored zoom, overview, resize bounds/aspect ratio, marquee and snapping passed');
