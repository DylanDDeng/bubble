/**
 * Tests for the blocking-interaction lifecycle (controller extraction §3).
 * The load-bearing assertions: every teardown path settles pending promises.
 */
import { describe, expect, it } from "vitest";
import { OwnedRequest, OverlayRequestController } from "../tui/controller/overlay-controller.js";

function settledMarker(): Promise<string> {
  return Promise.resolve("unused");
}
void settledMarker;

describe("overlay request lifecycle", () => {
  it("settles a plan request via user decision exactly once", async () => {
    const controller = new OverlayRequestController();
    const ref: { current?: (plan: string) => Promise<{ action: "approve" | "reject" }> } = {};
    controller.installPlanHandler(ref as never);

    const promise = ref.current!("my plan");
    expect(controller.pendingCount()).toBe(1);

    // Dispose cancels: the promise resolves (undefined = cancelled) so the
    // agent-side plan handler never hangs.
    controller.dispose();
    await expect(promise).resolves.toBeUndefined();
    expect(controller.pendingCount()).toBe(0);
  });

  it("settleAll(disposed) resolves every pending request on session switch", async () => {
    const controller = new OverlayRequestController();
    const planRef: { current?: (plan: string) => Promise<unknown> } = {};
    const approvalRef: { current?: (request: unknown) => Promise<unknown> } = {};
    controller.installPlanHandler(planRef as never);
    controller.installApprovalHandler(approvalRef as never);

    const planPromise = planRef.current!("plan");
    const approvalPromise = approvalRef.current!({ kind: "bash", command: "ls" } as never);

    const settled = controller.settleAll("session-switch");
    expect(settled).toBe(2);
    expect(controller.pendingCount()).toBe(0);

    await expect(planPromise).resolves.toBeUndefined();
    await expect(approvalPromise).resolves.toBeUndefined();
  });

  it("settleAll is idempotent across repeated teardowns", () => {
    const controller = new OverlayRequestController();
    controller.openFeedback("something odd");
    expect(controller.settleAll("shutdown")).toBe(1);
    expect(controller.settleAll("shutdown")).toBe(0);
    expect(controller.settleAll("session-switch")).toBe(0);
  });

  it("OwnedRequest.settle only fires once", () => {
    let settleEvents = 0;
    const request = new OwnedRequest<string>("q-1", "question", () => {
      settleEvents += 1;
    });
    expect(request.settle("yes", "user")).toBe(true);
    expect(request.settle("again", "user")).toBe(false);
    expect(settleEvents).toBe(1);
    expect(request.state).toBe("accepted");
  });
});
