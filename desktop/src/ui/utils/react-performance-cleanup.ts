/**
 * React's development Performance Tracks serialize changed props into User
 * Timing entries. During streaming this stores a new copy of the entire growing
 * response per commit, in Chromium's native timeline buffer (outside the JS
 * heap). GC cannot release those entries until the timeline is cleared.
 *
 * Clear only React's measurements after observers have received them. DevTools
 * recordings still receive the original trace events; application measurements
 * and marks remain untouched. No application/history/model data is truncated.
 */
export function installReactPerformanceCleanup(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const observer = new PerformanceObserver(list => {
    const names = new Set<string>();
    for (const entry of list.getEntries()) {
      const devtools = (entry as PerformanceMeasure).detail?.devtools;
      if (devtools?.track === 'Components ⚛' || devtools?.trackGroup === 'Scheduler ⚛') {
        names.add(entry.name);
      }
    }
    for (const name of names) performance.clearMeasures(name);
  });
  observer.observe({ type: 'measure', buffered: true });
  return () => observer.disconnect();
}
