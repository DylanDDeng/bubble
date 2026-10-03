import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The app chrome is monochrome; hues are reserved for canvas selection, diff and change states.
const css = readFileSync(
  join(import.meta.dirname, "../../src/ui/components/design/design.css"),
  "utf8",
);
assert(!css.includes("--accent"), "design.css must not use the app accent");
const tokens = new Set(["#0d99ff", "#b7791f", "#2f855a", "#c53030"]);
for (const [hex] of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
  const v = hex.toLowerCase();
  if (tokens.has(v)) continue;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  assert(
    Math.max(r, g, b) - Math.min(r, g, b) <= 12,
    `saturated color ${hex} outside the token block`,
  );
}
const tokenUses = css.match(/#(0d99ff|b7791f|2f855a|c53030)\b/gi) ?? [];
assert.equal(tokenUses.length, 4, "semantic hues are declared once as tokens");
console.log("Design palette: monochrome chrome and semantic tokens passed");
