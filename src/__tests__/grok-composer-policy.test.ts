import { describe, expect, it } from "vitest";
import { resolveComposerAtContext } from "../tui-ink/input-box.js";

describe("Grok constrained composer", () => {
  it("never opens workspace file discovery for @ syntax", () => {
    expect(resolveComposerAtContext("inspect @src/main.ts", 20, false, false)).toBeNull();
  });

  it("preserves native @mention completion outside constrained runtimes", () => {
    expect(resolveComposerAtContext("inspect @src/main.ts", 20, false, true)).toMatchObject({
      query: "src/main.ts",
    });
  });

});
