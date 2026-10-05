import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { BrowserUsePermissionSettings, ChromeCookieImportStatus } from '../../types';
import { BrowserImportDialog } from '../browser/BrowserImportDialog';
import { BrowserClearDataDialog } from '../browser/BrowserClearDataDialog';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

/**
 * Browser Use master switch. Per-origin Ask/Allow/Block still exists in
 * the main process (cookie import pins imported hosts to ask), but the
 * settings page only exposes enable/disable so the list of sites does not
 * crowd the Browser tab.
 */
export function BrowserUseSettings() {
  const [settings, setSettings] = useState<BrowserUsePermissionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    window.electron
      .getBrowserUsePermissions()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retry]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      setSettings(await window.electron.setBrowserUseEnabled(enabled));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle browser use.');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <>
    <SettingsGroup title="Agent browsing">
      {loadError ? <div role="alert" className="py-3">Could not load browser permissions. <button className="settings-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !settings ? (
        <div className="px-4 py-2.5 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <SettingsRow
          variant="card"
          label="Enable Browser Use"
        >
          <SettingsToggle
            checked={settings.enabled}
            onChange={(value) => void setEnabled(value)}
            disabled={busy}
            ariaLabel="Toggle browser use"
          />
        </SettingsRow>
      )}
    </SettingsGroup>
    <ChromeCookieImportSettings />
    </>
  );
}

function ChromeCookieImportSettings() {
  const [importOpen, setImportOpen] = useState(false);
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [platformSupported, setPlatformSupported] = useState(true);
  const [status, setStatus] = useState<ChromeCookieImportStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.electron.getChromeCookieImportStatus());
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .detectBrowserImportSources()
      .then((detected) => {
        if (!cancelled) setPlatformSupported(detected.platformSupported);
      })
      .catch(() => {});
    refreshStatus().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  const clearImported = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.electron.clearImportedChromeCookies();
      if (!result.ok) {
        toast.error(result.errorMessage || 'Failed to clear imported cookies.');
        return;
      }
      toast.success(result.removed > 0 ? `Removed ${result.removed} imported cookies.` : 'No imported cookies to clear.');
      await refreshStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to clear imported cookies.');
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  return (
    <>
      <SettingsGroup title="Browser data">
        <SettingsRow
          variant="card"
          label="Import from browser"
          description={platformSupported ? 'Chrome, Arc, Edge, Brave, Chromium or Vivaldi' : 'Browser data import is available on macOS.'}
        >
          <button type="button" onClick={() => setImportOpen(true)} disabled={!platformSupported || busy} className="settings-button">Import…</button>
        </SettingsRow>
        <SettingsRow variant="card" label="Imported cookies" description={status?.importedAt ? `${status.cookieCount} cookies · ${status.domains.length} sites${status.profileName ? ` · ${status.profileName}` : ''}` : undefined}>
          {status?.importedAt ? <button type="button" onClick={() => void clearImported()} disabled={busy} className="settings-button">Clear</button> : <span className="text-[var(--text-muted)]">None</span>}
        </SettingsRow>
        <SettingsRow variant="card" label="Browsing data" description="History, cookies and site data, cached files">
          <button type="button" onClick={() => setClearDataOpen(true)} disabled={busy} className="settings-button">Clear…</button>
        </SettingsRow>
      </SettingsGroup>

      <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => void refreshStatus()} />
      <BrowserClearDataDialog
        open={clearDataOpen}
        onOpenChange={setClearDataOpen}
        onCleared={(types) => {
          if (types.includes('siteData')) void refreshStatus();
        }}
      />
    </>
  );
}
