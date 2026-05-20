import { describe, expect, it } from "vitest";
import {
  pageViewportRows,
  scrollViewportByRows,
  syncViewportAfterLayout,
  type ViewportScrollState,
} from "../tui-ink/viewport-scroll.js";

describe("viewport scroll state", () => {
  it("follows the tail when content grows at the bottom", () => {
    const state: ViewportScrollState = { scrollTop: 6, followTail: true };
    const next = syncViewportAfterLayout(state, {
      contentRows: 30,
      viewportRows: 10,
    });

    expect(next).toEqual({ scrollTop: 20, followTail: true });
  });

  it("keeps the user's position when content grows while scrolled up", () => {
    const state: ViewportScrollState = { scrollTop: 6, followTail: false };
    const next = syncViewportAfterLayout(state, {
      contentRows: 30,
      viewportRows: 10,
    });

    expect(next).toEqual({ scrollTop: 6, followTail: false });
  });

  it("re-enables tail follow when the user pages back to the bottom", () => {
    const state: ViewportScrollState = { scrollTop: 12, followTail: false };
    const metrics = { contentRows: 30, viewportRows: 10 };
    const next = scrollViewportByRows(state, metrics, pageViewportRows(metrics));

    expect(next).toEqual({ scrollTop: 20, followTail: true });
  });

  it("clamps scroll position after resize or clear", () => {
    const state: ViewportScrollState = { scrollTop: 50, followTail: false };
    const next = syncViewportAfterLayout(state, {
      contentRows: 12,
      viewportRows: 10,
    });

    expect(next).toEqual({ scrollTop: 2, followTail: true });
  });
});
