import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Cookie, History, Image } from '../icons';
import type { BrowserClearDataType, BrowserDataSummary } from '../../../shared/browser-types';
import { useBrowserStateStore } from '../../store/useBrowserStateStore';
import { cn } from '@/ui/lib/utils';
import {
  BROWSER_DIALOG_LIST_CLASS,
  BrowserCheckbox,
  BrowserDialog,
  BrowserDialogButton,
  BrowserDialogFooter,
  BrowserDialogHeader,
  BrowserDialogRow,
} from './browser-dialog';

type TimeRange = 'lastHour' | 'lastDay' | 'lastWeek' | 'lastMonth' | 'allTime';
type DataKind = 'history' | BrowserClearDataType;

const TIME_RANGES: Array<{ value: TimeRange; label: string; ms: number }> = [
  { value: 'lastHour', label: 'Last hour', ms: 60 * 60 * 1000 },
  { value: 'lastDay', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: 'lastWeek', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: 'lastMonth', label: 'Last 4 weeks', ms: 28 * 24 * 60 * 60 * 1000 },
  { value: 'allTime', label: 'All time', ms: Number.POSITIVE_INFINITY },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function BrowserClearDataDialog({
  open,
  onOpenChange,
  onCleared,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCleared?: (types: DataKind[]) => void;
}) {
  const historyBySession = useBrowserStateStore((s) => s.recentHistoryBySessionId);
  const clearHistory = useBrowserStateStore((s) => s.clearHistory);
  const [range, setRange] = useState<TimeRange>('lastHour');
  const [checked, setChecked] = useState<Set<DataKind>>(() => new Set<DataKind>(['history', 'siteData', 'cache']));
  const [summary, setSummary] = useState<BrowserDataSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setRange('lastHour');
    setChecked(new Set<DataKind>(['history', 'siteData', 'cache']));
    setOpenedAt(Date.now());
    setSummary(null);
    let cancelled = false;
    window.electron.browser
      .getDataSummary()
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const sinceMs = openedAt - (TIME_RANGES.find((item) => item.value === range)?.ms ?? 0);
  const historySites = useMemo(() => {
    const hosts = new Set<string>();
    for (const entry of Object.values(historyBySession).flat()) {
      if (entry.lastVisitedAt >= sinceMs) hosts.add(hostOf(entry.url));
    }
    return [...hosts];
  }, [historyBySession, sinceMs]);

  // Chromium clears cookies, site storage and cache for all time only.
  const available = (kind: DataKind) => kind === 'history' || range === 'allTime';
  const selected = [...checked].filter(available);

  const rows: Array<{ kind: DataKind; icon: ReactNode; label: string; description: string }> = [
    {
      kind: 'history',
      icon: <History className="h-[18px] w-[18px]" />,
      label: 'Browsing history',
      description:
        historySites.length === 0
          ? 'No sites visited'
          : historySites.length === 1
            ? `From ${historySites[0]}`
            : `From ${historySites[0]} + ${plural(historySites.length - 1, 'site', 'sites')}`,
    },
    {
      kind: 'siteData',
      icon: <Cookie className="h-[18px] w-[18px]" />,
      label: 'Cookies and site data',
      description: !available('siteData')
        ? 'Only cleared for All time'
        : summary?.cookieSiteCount === 0
          ? 'No cookies stored'
          : summary
            ? `Stored for ${plural(summary.cookieSiteCount, 'site', 'sites')} — you’ll be signed out of them`
            : 'You’ll be signed out of most sites',
    },
    {
      kind: 'cache',
      icon: <Image className="h-[18px] w-[18px]" />,
      label: 'Cached images and files',
      description: !available('cache')
        ? 'Only cleared for All time'
        : summary
          ? `Current cache size: ${formatBytes(summary.cacheBytes)}`
          : 'Frees up space; some sites load slower next time',
    },
  ];

  const clear = async () => {
    setBusy(true);
    try {
      if (selected.includes('history')) clearHistory(range === 'allTime' ? 0 : sinceMs);
      const types = selected.filter((kind): kind is BrowserClearDataType => kind !== 'history');
      if (types.length > 0) await window.electron.browser.clearData(types);
      toast.success('Browsing data cleared');
      onCleared?.(selected);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? `Unable to clear browsing data: ${error.message}` : 'Unable to clear browsing data');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BrowserDialog open={open} onOpenChange={onOpenChange} dismissible={!busy} width={500} data-testid="browser-clear-data-dialog">
      <BrowserDialogHeader title="Clear browsing data" />
      <div className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Time range" className="flex flex-wrap gap-1.5">
          {TIME_RANGES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={range === item.value}
              disabled={busy}
              onClick={() => setRange(item.value)}
              className={cn(
                'h-7 shrink-0 rounded-full px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                range === item.value
                  ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]'
                  : 'border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className={BROWSER_DIALOG_LIST_CLASS}>
          {rows.map((row) => {
            const id = `browser-clear-${row.kind}`;
            const enabled = available(row.kind);
            return (
              <BrowserDialogRow
                key={row.kind}
                htmlFor={id}
                icon={row.icon}
                label={row.label}
                description={row.description}
                disabled={!enabled}
                control={
                  <BrowserCheckbox
                    id={id}
                    label={row.label}
                    checked={enabled && checked.has(row.kind)}
                    disabled={!enabled || busy}
                    onChange={(next) =>
                      setChecked((prev) => {
                        const updated = new Set(prev);
                        if (next) updated.add(row.kind);
                        else updated.delete(row.kind);
                        return updated;
                      })
                    }
                  />
                }
              />
            );
          })}
        </div>
      </div>
      <BrowserDialogFooter>
        <BrowserDialogButton variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</BrowserDialogButton>
        <BrowserDialogButton variant="primary" loading={busy} disabled={selected.length === 0} onClick={() => void clear()}>
          Delete data
        </BrowserDialogButton>
      </BrowserDialogFooter>
    </BrowserDialog>
  );
}
