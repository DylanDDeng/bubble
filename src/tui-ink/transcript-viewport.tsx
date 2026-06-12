import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Box, measureElement, type DOMElement } from "ink";
import { resolveTranscriptScroll } from "../tui/transcript-scroll.js";
import { clampScrollTop, isAtBottom, maxScrollTop } from "./transcript-viewport-math.js";

export interface TranscriptViewportHandle {
  /**
   * Re-engage bottom-follow. Sets the pending force flag from
   * transcript-scroll.ts, so the snap survives streaming renders that land
   * between the request and the next measured layout.
   */
  forceScrollToBottom(): void;
  /** Scroll by N lines (negative = up). A user gesture: cancels a pending force. */
  scrollBy(lines: number): void;
  scrollPage(direction: "up" | "down"): void;
}

interface TranscriptViewportProps {
  children: React.ReactNode;
}

/**
 * Height-clamped scrolling viewport for the alt-screen transcript. The outer
 * box clips; the inner box carries the full transcript and slides via a
 * negative top margin. Follow policy is the shared transcript-scroll.ts:
 * stay snapped while at the bottom, hold position while reading history,
 * snap back on send/approval via forceScrollToBottom().
 */
export const TranscriptViewport = forwardRef<TranscriptViewportHandle, TranscriptViewportProps>(
  function TranscriptViewport({ children }, ref) {
    const viewportRef = useRef<DOMElement | null>(null);
    const contentRef = useRef<DOMElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const scrollTopRef = useRef(0);
    const followingRef = useRef(true);
    const forcePendingRef = useRef(false);
    // forceScrollToBottom must work even when no other state changes in the
    // same tick; bumping this guarantees a commit so the measuring effect runs.
    const [, setScrollEpoch] = useState(0);

    const applyScrollTop = (next: number) => {
      scrollTopRef.current = next;
      setScrollTop(next);
    };

    // measureElement returns the Yoga-computed size, valid only after layout —
    // callable from effects and input handlers, never during render.
    const measureHeights = () => ({
      viewportHeight: viewportRef.current ? measureElement(viewportRef.current).height : 0,
      contentHeight: contentRef.current ? measureElement(contentRef.current).height : 0,
    });

    // Content and viewport heights change with streaming text, tool expansion,
    // resize, and bottom-stack visibility — no dependency list covers them
    // all, so re-resolve after every commit. setState below bails out via
    // Object.is when nothing moved, so the steady state does not loop.
    useEffect(() => {
      const { viewportHeight, contentHeight } = measureHeights();
      if (viewportHeight <= 0) return;
      const action = resolveTranscriptScroll({
        forcePending: forcePendingRef.current,
        shouldFollow: followingRef.current,
        following: followingRef.current,
      });
      if (action === "scroll-bottom") {
        forcePendingRef.current = false;
        followingRef.current = true;
        applyScrollTop(maxScrollTop(contentHeight, viewportHeight));
      } else {
        const clamped = clampScrollTop(scrollTopRef.current, contentHeight, viewportHeight);
        followingRef.current = isAtBottom(clamped, contentHeight, viewportHeight);
        if (clamped !== scrollTopRef.current) applyScrollTop(clamped);
      }
    });

    useImperativeHandle(ref, () => {
      const scrollBy = (lines: number) => {
        forcePendingRef.current = false; // the user's latest gesture wins
        const { viewportHeight, contentHeight } = measureHeights();
        if (viewportHeight <= 0) return;
        const next = clampScrollTop(scrollTopRef.current + lines, contentHeight, viewportHeight);
        followingRef.current = isAtBottom(next, contentHeight, viewportHeight);
        if (next !== scrollTopRef.current) applyScrollTop(next);
      };
      return {
        forceScrollToBottom() {
          forcePendingRef.current = true;
          setScrollEpoch((epoch) => epoch + 1);
        },
        scrollBy,
        scrollPage(direction) {
          const { viewportHeight } = measureHeights();
          const step = Math.max(1, viewportHeight - 2);
          scrollBy(direction === "up" ? -step : step);
        },
      };
    }, []);

    return (
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflowY="hidden"
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-scrollTop}>
          {children}
        </Box>
      </Box>
    );
  },
);
