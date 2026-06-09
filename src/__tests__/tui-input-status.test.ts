import { describe, expect, it } from "vitest";
import {
  setUserInputStatus,
  userInputStatusBadgeLabel,
  type DisplayMessage,
} from "../tui/display-history.js";

describe("TUI input status badges", () => {
  const userMessage: DisplayMessage = {
    role: "user",
    content: "Also mention STEER_OK",
  };

  it("labels pending steer separately from queued input", () => {
    expect(userInputStatusBadgeLabel("pending_steer")).toBe("STEER");
    expect(userInputStatusBadgeLabel("queued")).toBe("QUEUED");
    expect(userInputStatusBadgeLabel()).toBeUndefined();
  });

  it("does not render pending steer as queued", () => {
    const pendingSteer = setUserInputStatus(userMessage, "pending_steer");

    expect(pendingSteer.inputStatus).toBe("pending_steer");
    expect(userInputStatusBadgeLabel(pendingSteer.inputStatus)).toBe("STEER");
    expect(userInputStatusBadgeLabel(pendingSteer.inputStatus)).not.toBe("QUEUED");
  });

  it("clears the badge when steer is applied to the current run", () => {
    const pendingSteer = setUserInputStatus(userMessage, "pending_steer");
    const appliedSteer = setUserInputStatus(pendingSteer);

    expect(appliedSteer.inputStatus).toBeUndefined();
    expect(userInputStatusBadgeLabel(appliedSteer.inputStatus)).toBeUndefined();
  });

  it("moves rejected steer back to the queued badge", () => {
    const pendingSteer = setUserInputStatus(userMessage, "pending_steer");
    const rejectedSteer = setUserInputStatus(pendingSteer, "queued");

    expect(rejectedSteer.inputStatus).toBe("queued");
    expect(userInputStatusBadgeLabel(rejectedSteer.inputStatus)).toBe("QUEUED");
  });
});
