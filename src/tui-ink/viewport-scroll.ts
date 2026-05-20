export interface ViewportMetrics {
  contentRows: number;
  viewportRows: number;
}

export interface ViewportScrollState {
  scrollTop: number;
  followTail: boolean;
}

export function maxScrollTop(metrics: ViewportMetrics): number {
  return Math.max(0, metrics.contentRows - metrics.viewportRows);
}

export function clampViewportScroll(
  state: ViewportScrollState,
  metrics: ViewportMetrics,
): ViewportScrollState {
  const max = maxScrollTop(metrics);
  const scrollTop = state.followTail
    ? max
    : Math.min(Math.max(0, state.scrollTop), max);
  return {
    scrollTop,
    followTail: state.followTail || scrollTop >= max,
  };
}

export function syncViewportAfterLayout(
  state: ViewportScrollState,
  metrics: ViewportMetrics,
): ViewportScrollState {
  return clampViewportScroll(state, metrics);
}

export function scrollViewportByRows(
  state: ViewportScrollState,
  metrics: ViewportMetrics,
  deltaRows: number,
): ViewportScrollState {
  const max = maxScrollTop(metrics);
  const nextTop = Math.min(Math.max(0, state.scrollTop + deltaRows), max);
  return {
    scrollTop: nextTop,
    followTail: nextTop >= max,
  };
}

export function pageViewportRows(metrics: ViewportMetrics): number {
  return Math.max(1, metrics.viewportRows - 2);
}
