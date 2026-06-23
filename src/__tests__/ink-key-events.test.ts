import { describe, expect, it } from "vitest";
import { isKeyReleaseEvent } from "../tui-ink/key-events.js";

describe("Ink key events", () => {
  it("filters kitty keyboard release events without dropping press or repeat", () => {
    expect(isKeyReleaseEvent({ eventType: "release" })).toBe(true);
    expect(isKeyReleaseEvent({ eventType: "press" })).toBe(false);
    expect(isKeyReleaseEvent({ eventType: "repeat" })).toBe(false);
    expect(isKeyReleaseEvent({})).toBe(false);
  });
});
