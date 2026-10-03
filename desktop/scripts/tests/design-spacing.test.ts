import assert from "node:assert/strict";
import {
  absoluteConstraints,
  gapRegions,
  paddingRegions,
  type LayerLayout,
} from "../../src/ui/components/design/design-spacing";

const base: LayerLayout = {
  rect: { x: 40, y: 600, width: 1200, height: 364 },
  display: "flex",
  direction: "row",
  rowGap: 0,
  columnGap: 24,
  padding: [32, 32, 32, 32],
  position: "static",
  cb: { x: 0, y: 0, width: 1280, height: 1400 },
  children: [
    { id: "a", rect: { x: 72, y: 632, width: 362, height: 300 } },
    { id: "b", rect: { x: 458, y: 632, width: 362, height: 300 } },
    { id: "c", rect: { x: 844, y: 632, width: 362, height: 300 } },
  ],
  siblings: [],
};
const gaps = gapRegions(base);
assert.equal(gaps.length, 2);
assert.deepEqual(gaps[0], { rect: { x: 434, y: 632, width: 24, height: 300 }, prop: "column-gap", axis: "x" });
const column = gapRegions({
  ...base,
  children: [
    { id: "a", rect: { x: 0, y: 0, width: 100, height: 40 } },
    { id: "b", rect: { x: 0, y: 56, width: 80, height: 40 } },
  ],
});
assert.deepEqual(column, [{ rect: { x: 0, y: 40, width: 80, height: 16 }, prop: "row-gap", axis: "y" }]);
const pads = paddingRegions(base);
assert.deepEqual(pads.find((p) => p.side === "right")!.rect, { x: 1208, y: 600, width: 32, height: 364 });
// Top-right badge pins top and right; a bottom-left one pins bottom and left.
assert.deepEqual(absoluteConstraints({ x: 270, y: 24, width: 150, height: 44 }, { x: 0, y: 0, width: 444, height: 300 }), {
  left: "auto",
  right: "24px",
  top: "24px",
  bottom: "auto",
});
assert.deepEqual(absoluteConstraints({ x: 10, y: 250, width: 40, height: 20 }, { x: 0, y: 0, width: 444, height: 300 }), {
  left: "10px",
  right: "auto",
  top: "auto",
  bottom: "30px",
});
console.log("Design spacing: gap regions, padding bands and absolute constraints passed");
