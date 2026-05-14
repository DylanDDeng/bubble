import { describe, expect, it } from "vitest";
import { needsCursorRowCompensation } from "../tui-ink/input-box.js";

describe("Ink input cursor row compensation", () => {
  it("compensates fullscreen frames where Ink omits the trailing newline", () => {
    expect(needsCursorRowCompensation(24, 24, null)).toBe(true);
    expect(needsCursorRowCompensation(30, 24, 24)).toBe(true);
  });

  it("does not compensate ordinary non-fullscreen frames", () => {
    expect(needsCursorRowCompensation(20, 24, null)).toBe(false);
    expect(needsCursorRowCompensation(20, 24, 18)).toBe(false);
  });

  it("compensates the clear/sync frame after an overflowing response shrinks", () => {
    expect(needsCursorRowCompensation(20, 24, 30)).toBe(true);
    expect(needsCursorRowCompensation(20, 24, 24)).toBe(true);
  });
});
