import { describe, expect, it } from "vitest";
import {
  clampScrollTop,
  isAtBottom,
  maxScrollTop,
} from "../tui-ink/transcript-viewport-math.js";
import { resolveTranscriptScroll } from "../tui/transcript-scroll.js";

describe("transcript viewport math", () => {
  it("computes max scroll as content minus viewport, never negative", () => {
    expect(maxScrollTop(100, 40)).toBe(60);
    expect(maxScrollTop(30, 40)).toBe(0);
    expect(maxScrollTop(0, 0)).toBe(0);
  });

  it("clamps scroll positions into the valid range", () => {
    expect(clampScrollTop(-5, 100, 40)).toBe(0);
    expect(clampScrollTop(20, 100, 40)).toBe(20);
    expect(clampScrollTop(999, 100, 40)).toBe(60);
    // Content shorter than the viewport always clamps to the top.
    expect(clampScrollTop(10, 20, 40)).toBe(0);
  });

  it("treats the bottom with one line of slack, mirroring the OpenTUI scrollbox", () => {
    expect(isAtBottom(60, 100, 40)).toBe(true);
    expect(isAtBottom(59, 100, 40)).toBe(true);
    expect(isAtBottom(58, 100, 40)).toBe(false);
    // Short content is always "at bottom".
    expect(isAtBottom(0, 20, 40)).toBe(true);
  });
});

describe("viewport follow policy integration", () => {
  // Simulates the state machine in transcript-viewport.tsx: following starts
  // true; a user scroll recomputes it from the new position and clears any
  // pending force; forceScrollToBottom sets the pending force which survives
  // intervening streaming updates.
  function simulate(viewport: number) {
    let scrollTop = 0;
    let following = true;
    let forcePending = false;
    let content = viewport; // starts exactly one screen tall

    const update = () => {
      const action = resolveTranscriptScroll({ forcePending, shouldFollow: following, following });
      if (action === "scroll-bottom") {
        forcePending = false;
        following = true;
        scrollTop = maxScrollTop(content, viewport);
      } else {
        scrollTop = clampScrollTop(scrollTop, content, viewport);
        following = isAtBottom(scrollTop, content, viewport);
      }
    };
    return {
      grow(lines: number) {
        content += lines;
        update();
      },
      shrink(lines: number) {
        content = Math.max(0, content - lines);
        update();
      },
      scrollBy(lines: number) {
        forcePending = false;
        scrollTop = clampScrollTop(scrollTop + lines, content, viewport);
        following = isAtBottom(scrollTop, content, viewport);
      },
      forceScrollToBottom() {
        forcePending = true;
        update();
      },
      get scrollTop() {
        return scrollTop;
      },
      get following() {
        return following;
      },
      get maxScroll() {
        return maxScrollTop(content, viewport);
      },
    };
  }

  it("follows the bottom while streaming grows the transcript", () => {
    const v = simulate(40);
    v.grow(30);
    expect(v.scrollTop).toBe(v.maxScroll);
    v.grow(50);
    expect(v.scrollTop).toBe(v.maxScroll);
    expect(v.following).toBe(true);
  });

  it("holds position while the user reads history, even as content grows", () => {
    const v = simulate(40);
    v.grow(100);
    v.scrollBy(-30);
    const held = v.scrollTop;
    expect(v.following).toBe(false);
    v.grow(25);
    expect(v.scrollTop).toBe(held);
    expect(v.following).toBe(false);
  });

  it("send re-engages follow from a scrolled-up position", () => {
    const v = simulate(40);
    v.grow(100);
    v.scrollBy(-50);
    expect(v.following).toBe(false);
    v.forceScrollToBottom();
    expect(v.scrollTop).toBe(v.maxScroll);
    expect(v.following).toBe(true);
    // …and keeps following the turn that streams in afterwards.
    v.grow(20);
    expect(v.scrollTop).toBe(v.maxScroll);
  });

  it("a wheel gesture after a force wins: the snap is cancelled", () => {
    const v = simulate(40);
    v.grow(100);
    v.scrollBy(-50);
    v.forceScrollToBottom();
    v.scrollBy(-3);
    expect(v.following).toBe(false);
    const held = v.scrollTop;
    v.grow(10);
    expect(v.scrollTop).toBe(held);
  });

  it("clamps when the transcript shrinks (e.g. /clear or /compact)", () => {
    const v = simulate(40);
    v.grow(100);
    v.scrollBy(-10);
    v.shrink(120);
    expect(v.scrollTop).toBe(0);
    expect(v.following).toBe(true);
  });
});
