import { describe, expect, it } from "vitest";
import { EscapeConfirmationGate } from "../tui/escape-confirmation.js";

describe("EscapeConfirmationGate", () => {
  it("arms on the first escape and confirms the same run on the second", () => {
    const gate = new EscapeConfirmationGate(1500);

    expect(gate.press(1, 1000)).toEqual({ action: "arm", expiresAt: 2500 });
    expect(gate.isArmed(1, 1200)).toBe(true);
    expect(gate.press(1, 1300)).toEqual({ action: "confirm" });
    expect(gate.isArmed(1, 1300)).toBe(false);
  });

  it("does not confirm after the window expires", () => {
    const gate = new EscapeConfirmationGate(1500);

    expect(gate.press(1, 1000)).toEqual({ action: "arm", expiresAt: 2500 });
    expect(gate.press(1, 3000)).toEqual({ action: "arm", expiresAt: 4500 });
  });

  it("does not confirm a different run", () => {
    const gate = new EscapeConfirmationGate(1500);

    expect(gate.press(1, 1000)).toEqual({ action: "arm", expiresAt: 2500 });
    expect(gate.press(2, 1200)).toEqual({ action: "arm", expiresAt: 2700 });
  });
});
