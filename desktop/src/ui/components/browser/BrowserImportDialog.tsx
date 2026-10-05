import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, CircleX, Cookie, Loader2, Search } from '../icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { SettingsToggle } from '../settings/SettingsPrimitives';
import type {
  ChromeCookieDomain,
  ChromeCookieImportCounts,
  ChromeCookieImportResult,
  ChromeCookieProfile,
  ChromeCookieProfilesResult,
} from '../../types';
import {
  BROWSER_DIALOG_LIST_CLASS,
  BrowserCheckbox,
  BrowserDialog,
  BrowserDialogButton,
  BrowserDialogFooter,
  BrowserDialogHeader,
  BrowserDialogRow,
  BrowserSegmented,
  BrowserSourceIcon,
} from './browser-dialog';

type SiteMode = 'all' | 'choose';
type Phase = 'form' | 'importing' | 'done';

export function describeImportCounts(counts: ChromeCookieImportCounts, siteCount?: number): string {
  const skipped = counts.skippedPartitioned + counts.skippedExpired + counts.skippedInvalid;
  const extras: string[] = [];
  if (skipped) extras.push(`${skipped} skipped`);
  if (counts.failed) extras.push(`${counts.failed} failed`);
  const sites = siteCount ? ` from ${siteCount} ${siteCount === 1 ? 'site' : 'sites'}` : '';
  return `Imported ${counts.imported} of ${counts.discovered} cookies${sites}${extras.length ? ` · ${extras.join(', ')}` : ''}`;
}

function defaultProfile(listing: ChromeCookieProfilesResult): ChromeCookieProfile | undefined {
  return listing.profiles.find((profile) => profile.hasCookies) ?? listing.profiles[0];
}

function ProfileLabel({ profile, listing }: { profile: ChromeCookieProfile; listing: ChromeCookieProfilesResult }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" title={profile.userName || undefined}>
      <BrowserSourceIcon source={profile.source} sources={listing.sources} />
      <span className="min-w-0 truncate text-[var(--text-primary)]">{profile.appName}</span>
      <span className="min-w-0 truncate text-[var(--text-muted)]">{profile.profileName}</span>
    </span>
  );
}

export function BrowserImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  const [listing, setListing] = useState<ChromeCookieProfilesResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState('');
  const [importCookies, setImportCookies] = useState(true);
  const [siteMode, setSiteMode] = useState<SiteMode>('all');
  const [domains, setDomains] = useState<ChromeCookieDomain[] | null>(null);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [selectedHosts, setSelectedHosts] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<ChromeCookieImportResult | null>(null);

  const loadProfiles = useCallback(async () => {
    setListError(null);
    try {
      const next = await window.electron.listChromeCookieProfiles();
      setListing(next);
      setProfilePath((current) =>
        next.profiles.some((profile) => profile.profilePath === current) ? current : defaultProfile(next)?.profilePath ?? ''
      );
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Could not look for browser profiles.');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setResult(null);
    setImportCookies(true);
    setSiteMode('all');
    void loadProfiles();
  }, [open, loadProfiles]);

  useEffect(() => {
    setDomains(null);
    setDomainsError(null);
    setSelectedHosts(new Set());
    setQuery('');
  }, [profilePath]);

  useEffect(() => {
    if (!open || siteMode !== 'choose' || !profilePath || domains || domainsError) return;
    let cancelled = false;
    window.electron
      .listChromeCookieDomains(profilePath)
      .then((listed) => {
        if (cancelled) return;
        if (listed.errorMessage) setDomainsError(listed.errorMessage);
        else setDomains(listed.domains);
      })
      .catch((error) => {
        if (!cancelled) setDomainsError(error instanceof Error ? error.message : 'Could not read sites.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, siteMode, profilePath, domains, domainsError]);

  const profile = listing?.profiles.find((item) => item.profilePath === profilePath);
  const sourceRunning = !!profile && !!listing?.sources.find((info) => info.source === profile.source)?.running;
  const visibleDomains = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (domains ?? []).filter((domain) => !needle || domain.host.toLowerCase().includes(needle));
  }, [domains, query]);
  const canImport =
    phase === 'form' &&
    !!listing?.platformSupported &&
    !!profile &&
    importCookies &&
    (siteMode === 'all' || selectedHosts.size > 0);
  const busy = phase === 'importing';

  const runImport = async () => {
    if (!profile) return;
    setPhase('importing');
    try {
      const next = await window.electron.importChromeCookies({
        profilePath: profile.profilePath,
        domains: siteMode === 'choose' ? [...selectedHosts] : [],
      });
      setResult(next);
      if (next.cookies?.imported) onImported?.();
    } catch (error) {
      setResult({ ok: false, errorMessage: error instanceof Error ? error.message : 'Import failed.' });
    }
    setPhase('done');
  };

  const toggleHost = (host: string, checked: boolean) =>
    setSelectedHosts((prev) => {
      const next = new Set(prev);
      if (checked) next.add(host);
      else next.delete(host);
      return next;
    });

  if (phase !== 'form') {
    return (
      <BrowserDialog open={open} onOpenChange={onOpenChange} dismissible={!busy} data-testid="browser-import-dialog">
        <ImportProgress phase={phase} result={result} appName={profile?.appName ?? 'browser'} />
        <BrowserDialogFooter>
          {phase === 'done' && !result?.ok ? (
            <BrowserDialogButton variant="secondary" onClick={() => setPhase('form')}>Retry</BrowserDialogButton>
          ) : null}
          <BrowserDialogButton variant="primary" loading={busy} onClick={() => onOpenChange(false)}>
            {busy ? 'Importing…' : 'Done'}
          </BrowserDialogButton>
        </BrowserDialogFooter>
      </BrowserDialog>
    );
  }

  return (
    <BrowserDialog open={open} onOpenChange={onOpenChange} width={460} data-testid="browser-import-dialog">
      <BrowserDialogHeader title="Import from your browser" subtitle="Choose data to bring over to the built-in browser" />

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[13px] text-[var(--text-secondary)]">From</span>
          {!listing ? (
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[var(--border)] px-3 text-[13px] text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading profiles…
            </div>
          ) : listing.profiles.length <= 1 ? (
            <div className="flex h-9 min-w-0 flex-1 items-center rounded-[10px] border border-[var(--border)] px-3 text-[13px]">
              {profile ? <ProfileLabel profile={profile} listing={listing} /> : <span className="text-[var(--text-muted)]">No profiles found</span>}
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Browser profile"
                  className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[var(--border)] px-3 text-left text-[13px] outline-none transition-colors hover:bg-[var(--sidebar-item-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[popup-open]:bg-[var(--sidebar-item-hover)]"
                >
                  {profile ? <ProfileLabel profile={profile} listing={listing} /> : <span className="flex-1 text-[var(--text-muted)]">Choose a profile</span>}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="max-h-[250px] min-w-[300px] overflow-y-auto">
                {listing.profiles.map((item) => (
                  <DropdownMenuItem
                    key={item.profilePath}
                    className="gap-2 py-1.5 text-[13px]"
                    onClick={() => setProfilePath(item.profilePath)}
                  >
                    <ProfileLabel profile={item} listing={listing} />
                    <Check className={`h-3.5 w-3.5 shrink-0 ${item.profilePath === profilePath ? '' : 'invisible'}`} aria-hidden="true" />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {listing && !listing.platformSupported ? (
          <p className="text-[13px] leading-5 text-[var(--text-secondary)]">{listing.errorMessage}</p>
        ) : listing && listing.profiles.length === 0 ? (
          <p className="text-[13px] leading-5 text-[var(--text-secondary)]">
            {listing.errorMessage || 'No Chrome, Arc, Edge, Brave, Chromium or Vivaldi profiles were found on this device'}
          </p>
        ) : profile ? (
          <p className="text-[13px] leading-5 text-[var(--text-secondary)]">
            {sourceRunning
              ? `Keep ${profile.appName} open — quitting it clears session-only cookies`
              : `Open ${profile.appName} and sign in first if you need session cookies`}
          </p>
        ) : null}
        {listing?.errorMessage && listing.profiles.length > 0 ? (
          <p role="alert" className="text-[12px] leading-4 text-[var(--error)]">{listing.errorMessage}</p>
        ) : null}
        {listError ? <p role="alert" className="text-[12px] leading-4 text-[var(--error)]">{listError}</p> : null}

        {profile ? (
          <div className={BROWSER_DIALOG_LIST_CLASS}>
            <BrowserDialogRow
              icon={<Cookie className="h-[18px] w-[18px]" />}
              label="Cookies"
              description="Stay signed in to your sites"
              control={<SettingsToggle checked={importCookies} onChange={setImportCookies} ariaLabel="Import cookies" />}
            />
            {importCookies ? (
              <div className="flex flex-col">
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1 pl-8 text-[13px] text-[var(--text-primary)]">Sites</span>
                  <BrowserSegmented
                    label="Sites to import"
                    value={siteMode}
                    onChange={setSiteMode}
                    options={[
                      { value: 'all', label: 'All sites' },
                      { value: 'choose', label: 'Choose sites' },
                    ]}
                  />
                </div>
                {siteMode === 'choose' ? (
                  <SitePicker
                    domains={domains}
                    visibleDomains={visibleDomains}
                    error={domainsError}
                    query={query}
                    onQueryChange={setQuery}
                    selected={selectedHosts}
                    onToggle={toggleHost}
                    onSelectVisible={(checked) =>
                      setSelectedHosts((prev) => {
                        const next = new Set(prev);
                        for (const domain of visibleDomains) {
                          if (checked) next.add(domain.host);
                          else next.delete(domain.host);
                        }
                        return next;
                      })
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {profile ? (
          <p className="text-[12px] leading-4 text-[var(--text-muted)]">
            Imported sites still ask before the agent can use them.
          </p>
        ) : null}
      </div>

      <BrowserDialogFooter>
        <BrowserDialogButton variant="secondary" onClick={() => onOpenChange(false)}>Cancel</BrowserDialogButton>
        <BrowserDialogButton variant="primary" disabled={!canImport} onClick={() => void runImport()}>
          Import
        </BrowserDialogButton>
      </BrowserDialogFooter>
    </BrowserDialog>
  );
}

function SitePicker({
  domains,
  visibleDomains,
  error,
  query,
  onQueryChange,
  selected,
  onToggle,
  onSelectVisible,
}: {
  domains: ChromeCookieDomain[] | null;
  visibleDomains: ChromeCookieDomain[];
  error: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  selected: Set<string>;
  onToggle: (host: string, checked: boolean) => void;
  onSelectVisible: (checked: boolean) => void;
}) {
  if (error) return <p role="alert" className="px-3 pb-3 text-[12px] leading-4 text-[var(--error)]">{error}</p>;
  if (!domains) {
    return (
      <div className="flex items-center gap-2 px-3 pb-3 text-[12px] text-[var(--text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Reading sites…
      </div>
    );
  }
  const allVisibleSelected = visibleDomains.length > 0 && visibleDomains.every((domain) => selected.has(domain.host));
  return (
    <div className="flex flex-col gap-2 px-3 pb-3" data-browser-import-sites>
      <div className="flex items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-[var(--sidebar-item-hover)] px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search sites"
            aria-label="Search sites"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
        <BrowserDialogButton
          size="toolbar"
          variant="ghost"
          disabled={visibleDomains.length === 0}
          onClick={() => onSelectVisible(!allVisibleSelected)}
        >
          {allVisibleSelected ? 'Clear' : 'Select all'}
        </BrowserDialogButton>
      </div>
      <div className="max-h-[188px] overflow-y-auto rounded-[9px] border border-[var(--border)]">
        {visibleDomains.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-[var(--text-muted)]">{domains.length ? 'No matching sites' : 'This profile has no cookies'}</p>
        ) : (
          visibleDomains.map((domain) => {
            const id = `browser-import-site-${domain.host}`;
            return (
              <label key={domain.host} htmlFor={id} className="flex h-8 cursor-pointer items-center gap-2.5 px-2.5 hover:bg-[var(--sidebar-item-hover)]">
                <BrowserCheckbox
                  id={id}
                  checked={selected.has(domain.host)}
                  onChange={(checked) => onToggle(domain.host, checked)}
                  label={domain.host}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{domain.host}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{domain.cookieCount}</span>
              </label>
            );
          })
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        {selected.size} of {domains.length} {domains.length === 1 ? 'site' : 'sites'} selected
      </p>
    </div>
  );
}

function ImportProgress({
  phase,
  result,
  appName,
}: {
  phase: Phase;
  result: ChromeCookieImportResult | null;
  appName: string;
}) {
  const importing = phase === 'importing';
  const partial = !!result && !result.ok && (result.cookies?.imported ?? 0) > 0;
  const title = importing ? 'Importing…' : result?.ok || partial ? 'Import complete' : 'Import failed';
  const subtitle = importing
    ? `Bringing over your ${appName} data`
    : result?.ok || partial
      ? 'Your data is now available in the built-in browser'
      : 'We were unable to import your browsing data';
  const icon = importing ? (
    <Loader2 className="h-5 w-5 animate-spin text-[var(--text-secondary)]" aria-hidden="true" />
  ) : result?.ok ? (
    <CheckCircle2 className="h-5 w-5 text-[var(--success)]" aria-hidden="true" />
  ) : partial ? (
    <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />
  ) : (
    <CircleX className="h-5 w-5 text-[var(--error)]" aria-hidden="true" />
  );
  const detail = importing
    ? 'Importing cookies…'
    : [
        result?.cookies ? describeImportCounts(result.cookies, result.importedHosts?.length) : null,
        result && !result.ok ? result.errorMessage : null,
      ]
        .filter(Boolean)
        .join('. ');
  return (
    <>
      <BrowserDialogHeader title={title} subtitle={subtitle} />
      <div className={BROWSER_DIALOG_LIST_CLASS} role="status" aria-live="polite">
        <BrowserDialogRow icon={<Cookie className="h-[18px] w-[18px]" />} label="Cookies" description={detail} control={icon} />
      </div>
    </>
  );
}
