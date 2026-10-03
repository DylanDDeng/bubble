import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

const ActivityAnimationContext = createContext(true);
export function ActivityAnimationScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <ActivityAnimationContext.Provider value={enabled}>{children}</ActivityAnimationContext.Provider>;
}

/** Shared disclosure motion for a turn and its individual activities. */
export function WorkstreamCollapse({ open, children, variant = 'activity' }: { open: boolean; children: ReactNode; variant?: 'activity' | 'turn' }) {
  const reducedMotion = useAppReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <CollapseBody reducedMotion={reducedMotion} variant={variant}>{children}</CollapseBody>
      )}
    </AnimatePresence>
  );
}

function CollapseBody({ children, reducedMotion, variant }: { children: ReactNode; reducedMotion: boolean; variant: 'activity' | 'turn' }) {
  const present = useIsPresent();
  const isTurn = variant === 'turn';
  const hiddenY = isTurn && !reducedMotion ? -8 : 0;
  return (
    <motion.div
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={{ height: reducedMotion ? 'auto' : 0, opacity: 0, y: hiddenY }}
      animate={{ height: 'auto', opacity: 1, y: 0, transitionEnd: { overflow: 'visible' } }}
      exit={{ height: reducedMotion ? 'auto' : 0, opacity: 0, y: hiddenY, overflow: 'hidden',
        transition: { duration: isTurn ? 0.15 : reducedMotion ? 0 : 0.3, ease: isTurn ? [0.23, 1, 0.32, 1] : [0.19, 1, 0.22, 1] } }}
      transition={{ duration: isTurn ? reducedMotion ? 0.12 : 0.22 : reducedMotion ? 0 : 0.3, ease: isTurn ? [0.33, 1, 0.68, 1] : [0.19, 1, 0.22, 1] }}
      style={{ overflow: 'hidden' }}
    >{children}</motion.div>
  );
}

/** Full-row toggle with separately clickable links, without nesting interactive elements. */
export function ActivityDisclosureHeader({ expanded, onToggle, children }: {
  expanded: boolean; onToggle: () => void; children: ReactNode;
}) {
  const labelId = useId();
  return <div className="group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
    <button type="button" aria-labelledby={labelId} aria-expanded={expanded} onClick={onToggle}
      className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2" />
    <span id={labelId} className="pointer-events-none relative min-w-0 break-words [&_button]:pointer-events-auto [&_a]:pointer-events-auto">{children}</span>
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      className={`pointer-events-none relative h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>
      <path d="m6 4 4 4-4 4" />
    </svg>
  </div>;
}

export function WorkstreamActivityLabel({ children, active }: { children: string; active: boolean }) {
  const reducedMotion = useAppReducedMotion();
  const enabled = useContext(ActivityAnimationContext);
  const animate = active && enabled && !reducedMotion;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!animate || !element) return;
    let end: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const sweep = () => {
      if (end) clearTimeout(end);
      element.classList.add('workstream-shimmer-active');
      end = setTimeout(() => element.classList.remove('workstream-shimmer-active'), 1000);
    };
    const start = setTimeout(() => { sweep(); interval = setInterval(sweep, 4000); }, 600);
    return () => {
      clearTimeout(start);
      if (end) clearTimeout(end);
      if (interval) clearInterval(interval);
      element.classList.remove('workstream-shimmer-active');
    };
  }, [animate]);
  return (
    <span ref={ref} className={`workstream-activity-label min-w-0 truncate ${animate ? 'workstream-shimmer' : ''}`}>
      {children}
      {animate && (
        <span aria-hidden="true" className="workstream-activity-shimmer"><span className="workstream-shimmer-highlight">{children}</span></span>
      )}
    </span>
  );
}

/** Codex holds each active identity for 1s; updates within it and terminal summaries are immediate. */
export function ActivitySummary({ summaryKey, immediate, children }: {
  summaryKey: string; immediate: boolean; children: ReactNode;
}) {
  const [shown, setShown] = useState({ key: summaryKey, node: children });
  const displayedAt = useRef<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    displayedAt.current ??= now;
    if (shown.key === summaryKey) return;
    const commit = () => {
      displayedAt.current = Date.now();
      setShown({ key: summaryKey, node: children });
    };
    const remaining = 1000 - (now - displayedAt.current);
    if (immediate || remaining <= 0) { commit(); return; }
    const timer = setTimeout(commit, remaining);
    return () => clearTimeout(timer);
  }, [summaryKey, immediate, children, shown.key]);
  return <span className="flex min-h-4 min-w-0 max-w-full items-center gap-1.5 truncate" data-activity-summary>
    {immediate || shown.key === summaryKey ? children : shown.node}
  </span>;
}

/** Follow new activity until the reader deliberately scrolls back into history. */
export function WorkstreamScrollArea({ children, followKey, bounded = true }: { children: ReactNode; followKey?: string; bounded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !bounded) return;
    const update = () => {
      if (followKey && following.current) element.scrollTop = element.scrollHeight;
      setEdges({ top: element.scrollTop > 1, bottom: element.scrollHeight - element.clientHeight - element.scrollTop > 1 });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [followKey, bounded]);
  return (
    <div ref={ref} className="workstream-scroll-area" data-bounded={bounded} data-fade-top={edges.top} data-fade-bottom={edges.bottom}
      onPointerDownCapture={(event) => {
        if ((event.target as Element).closest('button')) following.current = false;
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
        // Only resume at the actual bottom. A whole-row tolerance steals the
        // viewport when the reader scrolls to the top of a short overflow.
        following.current = remaining < 2;
        setEdges({ top: element.scrollTop > 1, bottom: remaining > 1 });
      }}>
      <div>{children}</div>
    </div>
  );
}
