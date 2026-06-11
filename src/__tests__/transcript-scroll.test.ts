import { describe, expect, it } from "vitest";
import { resolveTranscriptScroll } from "../tui/transcript-scroll.js";

describe("transcript scroll-follow policy", () => {
  it("keeps following when the user is at the bottom", () => {
    expect(resolveTranscriptScroll({ forcePending: false, shouldFollow: true, following: true }))
      .toBe("scroll-bottom");
  });

  it("stays put during streaming when the user has scrolled up", () => {
    expect(resolveTranscriptScroll({ forcePending: false, shouldFollow: false, following: false }))
      .toBe("sync-position");
  });

  it("snaps to the bottom when the user sends a message while scrolled up", () => {
    // runAgentInput / addUserInputStatusDisplay render with forceFollow,
    // which sets forcePending regardless of the current viewport position.
    expect(resolveTranscriptScroll({ forcePending: true, shouldFollow: true, following: true }))
      .toBe("scroll-bottom");
  });

  it("force snap survives an intervening streaming redraw that recomputed follow=false", () => {
    // Race: send (forceFollow) schedules a deferred scroll; before it fires, a
    // streaming redraw reads the still-unscrolled position and flips the live
    // follow flag back to false. The pending force must still win.
    expect(resolveTranscriptScroll({ forcePending: true, shouldFollow: true, following: false }))
      .toBe("scroll-bottom");
  });

  it("does not snap when following lapsed and no force is pending", () => {
    // shouldFollow was captured true at schedule time, but the user scrolled
    // up before the deferred scroll ran — their gesture wins.
    expect(resolveTranscriptScroll({ forcePending: false, shouldFollow: true, following: false }))
      .toBe("sync-position");
  });
});
