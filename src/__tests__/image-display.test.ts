import { describe, expect, it } from "vitest";
import {
  formatImageUserDisplayText,
  imageDisplayLabel,
  imageDisplayReferenceLine,
  isImageDisplayReferenceLine,
  nextImageDisplayLabelStart,
  splitImageDisplayContent,
  stripInlineImageLabels,
} from "../tui/image-display.js";

describe("stripInlineImageLabels", () => {
  it("removes an inline label (and its trailing space) at any position", () => {
    expect(stripInlineImageLabels("look at [Image #1] here", ["[Image #1]"])).toBe("look at here");
    expect(stripInlineImageLabels("[Image #1] start", ["[Image #1]"])).toBe("start");
    expect(stripInlineImageLabels("end [Image #2]", ["[Image #2]"])).toBe("end ");
  });

  it("removes each label once, in order, leaving unrelated text intact", () => {
    expect(stripInlineImageLabels("a [Image #1] b [Image #2] c", ["[Image #1]", "[Image #2]"]))
      .toBe("a b c");
  });

  it("is a no-op when the labels are absent (history replay / no images)", () => {
    expect(stripInlineImageLabels("just text", ["[Image #1]"])).toBe("just text");
    expect(stripInlineImageLabels("hello", [])).toBe("hello");
  });
});

describe("image display formatting", () => {
  it("renders a pasted image like the transcript attachment style", () => {
    expect(formatImageUserDisplayText("composer 这里点击加号 没有反应啊", 1, 3)).toBe(
      "[Image #3] composer 这里点击加号 没有反应啊\n└ [Image #3]",
    );
  });

  it("renders multiple images with stable labels", () => {
    expect(formatImageUserDisplayText("看看这些图", 2, 4)).toBe(
      "[Image #4] [Image #5] 看看这些图\n└ [Image #4]\n└ [Image #5]",
    );
  });

  it("leaves non-image messages unchanged", () => {
    expect(formatImageUserDisplayText("  /model  ", 0, 8)).toBe("  /model  ");
  });

  it("builds composer preview reference lines", () => {
    expect(imageDisplayReferenceLine(imageDisplayLabel(7))).toBe("└ [Image #7]");
  });

  it("detects attachment reference lines separately from message body text", () => {
    expect(isImageDisplayReferenceLine("└ [Image #7]")).toBe(true);
    expect(isImageDisplayReferenceLine("  └ [Image #7]")).toBe(false);
    expect(isImageDisplayReferenceLine("[Image #7]")).toBe(false);
    expect(isImageDisplayReferenceLine("└ [Image #7] please inspect")).toBe(false);
  });

  it("splits sent image display into body and reference rows", () => {
    expect(splitImageDisplayContent("[Image #3] composer\n└ [Image #3]")).toEqual({
      bodyLines: ["[Image #3] composer"],
      referenceLines: ["└ [Image #3]"],
    });
  });

  it("continues numbering from the current transcript", () => {
    expect(nextImageDisplayLabelStart([
      { content: "[Image #2] first\n└ [Image #2]" },
      { content: "assistant response" },
      { content: "[Image #9] later" },
    ])).toBe(10);
  });
});
