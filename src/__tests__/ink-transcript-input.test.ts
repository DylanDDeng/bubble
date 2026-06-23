import { describe, expect, it } from "vitest";
import { transcriptPageScrollDirection } from "../tui-ink/transcript-input.js";

describe("Ink transcript input dispatch", () => {
  it("maps PageUp and PageDown to transcript page scroll without overlays", () => {
    expect(transcriptPageScrollDirection({ pageUp: true }, { overlayActive: false })).toBe("up");
    expect(transcriptPageScrollDirection({ pageDown: true }, { overlayActive: false })).toBe("down");
  });

  it("does not scroll the transcript behind overlays", () => {
    expect(transcriptPageScrollDirection({ pageUp: true }, { overlayActive: true })).toBeUndefined();
    expect(transcriptPageScrollDirection({ pageDown: true }, { overlayActive: true })).toBeUndefined();
  });
});
