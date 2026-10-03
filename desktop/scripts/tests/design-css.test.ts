import assert from "node:assert/strict";
import { readBoardBackground, setBoardBackground } from "../../src/shared/design-layers";
import { cssText, hexColors, swatchColor, toLayerCss } from "../../src/ui/components/design/design-css";

// Colors come back from the CSSOM as rgb(); show them as written in designs.
assert.equal(hexColors("rgb(31, 42, 34)"), "#1F2A22");
assert.equal(hexColors("0 1px 2px rgba(0, 0, 0, 0.5)"), "0 1px 2px #00000080");
assert.equal(hexColors("rgb(255 255 255 / 50%)"), "#FFFFFF80");
assert.equal(hexColors("Newsreader, serif"), "Newsreader, serif");
assert.equal(swatchColor("color", "rgb(31, 42, 34)"), "rgb(31, 42, 34)");
assert.equal(swatchColor("background-color", "#fff !important"), "#fff");
assert.equal(swatchColor("color", "inherit"), undefined);
assert.equal(swatchColor("font-family", "red"), undefined);
assert.equal(cssText([["font-size", "108px"], ["color", "rgb(0, 0, 0)"]]), "font-size: 108px;\ncolor: #000000;");

// The frame runs untrusted content: replies are validated and capped.
assert.equal(toLayerCss(null), null);
assert.equal(toLayerCss({ tag: "<script>", own: [] }), null);
const css = toLayerCss({
  tag: "h1",
  text: "x".repeat(200),
  own: [["font-size", "108px"], ["bad prop", "1"], [1, "2"], ["width", "x".repeat(2000)]],
  inherited: [
    { id: "hero", label: ".hero", decls: [["text-align", "left"]] },
    { label: "body", decls: [] },
    "junk",
  ],
})!;
assert.equal(css.text.length, 80);
assert.deepEqual(css.own.map((d) => d[0]), ["font-size", "width"]);
assert.equal(css.own[1][1].length, 1000);
assert.deepEqual(css.inherited, [{ id: "hero", label: ".hero", decls: [["text-align", "left"]] }]);

const bg = setBoardBackground('<html><head></head><body style="margin: 0; background: red"><p>x</p></body></html>', "#F3EFE7");
assert(bg.includes('style="margin: 0; background: #F3EFE7"'));
assert.equal(readBoardBackground(bg), "#F3EFE7");
assert.equal(readBoardBackground(setBoardBackground(bg, "")), undefined);
console.log("Design CSS: colors, swatches, reply validation and board background passed");
