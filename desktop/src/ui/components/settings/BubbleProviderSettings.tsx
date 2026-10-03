import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown } from '../icons';
import { ProviderLogo } from './ProviderLogo';
import type { BubbleProvidersConfig, BubbleOAuthState } from '../../../shared/types';
import { ProviderKeyEditor, ProviderSettingsRow, ProviderSettingsSection } from './ProviderSettingsPrimitives';

// Composer hooks re-fetch Bubble catalogs on this event; fire it after any
// credential change so the model picker updates without a restart.
function notifyBubbleConfigChanged() {
  window.dispatchEvent(new Event('bubble-model-config-updated'));
}

/**
 * Credentials for the bundled Bubble agent in the selected data environment.
 * Subscription tokens remain in the main process; only API keys have an editor.
 */
export function BubbleProviderSettings({ revealTarget }: { revealTarget?: string } = {}) {
  const [config, setConfig] = useState<BubbleProvidersConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const keyEdited = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [oauth, setOAuth] = useState<BubbleOAuthState>({ status: 'idle', providerId: null, canReopen: false });
  const [apiMode, setApiMode] = useState(false);
  const oauthSnapshot = useRef('');
  // null = "no explicit choice yet": the unconfigured catalog stays collapsed
  // once something is configured, but a brand-new user sees it open.
  const [showAvailable, setShowAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getBubbleProvidersConfig()
      .then((next) => {
        if (!cancelled) {
          setConfig(next);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const applyResult = useCallback((next: BubbleProvidersConfig) => {
    setConfig(next);
    notifyBubbleConfigChanged();
  }, []);

  // Poll only the tiny login state while settings are mounted. This also
  // restores an in-progress sign-in after navigating away and returning.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.electron.getBubbleOAuthState();
        if (disposed) return;
        setOAuth(next);
        const snapshot = `${next.providerId}:${next.status}`;
        if (snapshot !== oauthSnapshot.current) {
          oauthSnapshot.current = snapshot;
          if (next.status === 'success') {
            const refreshed = await window.electron.getBubbleProvidersConfig();
            if (!disposed) applyResult(refreshed);
          }
        }
      } catch { /* Initial load errors are shown by the provider config view. */ }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [applyResult]);

  const startLogin = async (providerId: string) => {
    setBusyId(providerId);
    try { setOAuth(await window.electron.startBubbleOAuth(providerId)); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not start sign-in.'); }
    finally { setBusyId(null); }
  };
  const cancelLogin = async () => {
    try { setOAuth(await window.electron.cancelBubbleOAuth()); }
    catch { toast.error('Could not cancel sign-in.'); }
  };
  const logout = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.logoutBubbleOAuth(providerId));
      setOAuth(await window.electron.getBubbleOAuthState());
      setKeyDraft('');
      setApiMode(false);
    } catch { toast.error('Could not sign out. Please try again.'); }
    finally { setBusyId(null); }
  };

  const toggleExpanded = (providerId: string) => {
    setApiMode(providers.find(provider => provider.id === providerId)?.authType === 'api');
    setExpandedId((current) => (current === providerId ? null : providerId));
    setKeyDraft('');
    keyEdited.current = false;
    setShowKey(false);
  };

  const saveKey = async (providerId: string) => {
    if (!keyDraft.trim()) {
      toast.error('Enter an API key first.');
      return;
    }
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderKey(providerId, keyDraft));
      setExpandedId(null);
      setKeyDraft('');
      toast.success(`Saved ${providerId} key for Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the key.');
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.removeBubbleProvider(providerId));
      setExpandedId(null);
      toast.success(`Removed ${providerId} from Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleDefaultProvider(providerId));
      toast.success(`${providerId} is now Bubble's default provider.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set the default provider.');
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (providerId: string, enabled: boolean) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderEnabled(providerId, enabled));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const providers = config?.providers || [];

  // Prefill the editor with the stored key when one exists, so the user sees
  // it masked (dots) and can reveal it with the eye toggle — the usual
  // "saved credential" pattern. Fetched on demand; the bulk config never
  // carries keys.
  useEffect(() => {
    if (!expandedId) return;
    const provider = providers.find((entry) => entry.id === expandedId);
    if (!provider?.hasApiKey) return;
    let cancelled = false;
    window.electron
      .getBubbleProviderKey(expandedId)
      .then((key) => {
        if (!cancelled && !keyEdited.current && key) setKeyDraft(key);
      })
      .catch(() => {
        // Leave the draft empty; the user can still type a replacement key.
      });
    return () => {
      cancelled = true;
    };
    // Only refetch when a different editor opens — refetching on config
    // changes (e.g. toggling another provider) would clobber an in-progress
    // edit with the stored key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);
  const configuredProviders = providers.filter((provider) => provider.configured);
  const availableProviders = providers.filter((provider) => !provider.configured);
  const availableVisible = showAvailable ?? configuredProviders.length === 0;

  useEffect(() => {
    if (revealTarget?.startsWith('Bubble:')) setShowAvailable(true);
  }, [revealTarget]);

  const renderRow = (provider: (typeof providers)[number]) => {
    const actions = [
      ...(provider.configured && provider.authType !== 'none' && provider.enabled && !provider.isDefault ? [{ label: 'Make default', onSelect: () => void makeDefault(provider.id) }] : []),
      ...(provider.configured ? [{ label: 'Remove provider', onSelect: () => void removeProvider(provider.id), destructive: true }] : []),
    ];
    const pending = oauth.status === 'pending';
    const signingIn = pending && oauth.providerId === provider.id;
    const locked = busyId !== null || pending;
    const subscription = provider.id === 'openai' ? 'ChatGPT subscription' : 'Grok subscription';
    return <ProviderSettingsRow key={provider.id} label={provider.name} scope="Bubble" logo={<ProviderLogo providerId={provider.id} name={provider.name} />}
      expanded={expandedId === provider.id} disabled={busyId !== null} isDefault={provider.isDefault}
      status={signingIn ? 'Signing in…' : provider.authType === 'none' ? (provider.supportsOAuth ? 'Not signed in' : 'No API key') : !provider.enabled ? 'Disabled' : provider.authType === 'oauth' ? 'Subscription connected' : 'API key'}
      enabled={provider.enabled} onToggleEnabled={provider.configured && !pending ? value => void setEnabled(provider.id, value) : undefined}
      onToggleExpand={() => toggleExpanded(provider.id)} actions={pending ? [] : actions}>
      {provider.supportsOAuth && <div className="provider-oauth-panel">
        {!provider.oauthOnly && <div className="provider-auth-mode" role="group" aria-label="Authentication method">
          <button type="button" className={!apiMode ? 'provider-primary-button' : 'provider-secondary-button'} aria-pressed={!apiMode} disabled={locked} onClick={() => setApiMode(false)}>ChatGPT subscription</button>
          <button type="button" className={apiMode ? 'provider-primary-button' : 'provider-secondary-button'} aria-pressed={apiMode} disabled={locked || provider.authType === 'oauth'} onClick={() => setApiMode(true)}>API key</button>
        </div>}
        {(!apiMode || provider.oauthOnly) && <>
          <p className="provider-oauth-description">{provider.authType === 'oauth' ? `Connected with your ${subscription}.` : `Sign in with your ${subscription} in the browser. No API key needed.`}</p>
          {signingIn && <p className="provider-oauth-description" role="status">{oauth.phase === 'exchanging' ? 'Authorization received. Exchanging credentials with the provider…' : oauth.phase === 'saving' ? 'Saving your sign-in…' : 'Waiting for browser authorization… You can cancel and try again.'}</p>}
          {oauth.status === 'error' && oauth.providerId === provider.id && <p className="provider-inline-error" role="alert">{oauth.phase === 'exchanging' && 'Browser authorization was received, but desktop sign-in could not finish. '}{oauth.error}</p>}
          <div className="provider-editor-footer">
            {signingIn ? <>
              {oauth.canReopen && <button type="button" className="provider-secondary-button" onClick={() => void window.electron.reopenBubbleOAuth().catch(() => toast.error('Could not open the browser.'))}>Open browser again</button>}
              <button type="button" className="provider-secondary-button" onClick={() => void cancelLogin()}>Cancel sign-in</button>
            </> : provider.authType === 'oauth' ? <button type="button" className="provider-secondary-button" disabled={locked} onClick={() => void logout(provider.id)}>Sign out</button>
              : <button type="button" className="provider-primary-button" disabled={locked} onClick={() => void startLogin(provider.id)}>Sign in with {provider.id === 'openai' ? 'ChatGPT' : 'Grok'}</button>}
          </div>
        </>}
      </div>}
      {(!provider.supportsOAuth || (apiMode && !provider.oauthOnly)) && <ProviderKeyEditor label={`${provider.name} API key for Bubble`} value={keyDraft} onChange={value => { keyEdited.current = true; setKeyDraft(value); }} showKey={showKey} onToggleVisibility={() => setShowKey(value => !value)} busy={locked} onSave={() => void saveKey(provider.id)} onCancel={() => toggleExpanded(provider.id)} />}
    </ProviderSettingsRow>;
  };
  return <ProviderSettingsSection title="Bubble">
    {loadError ? <div className="provider-load-message" role="alert">Could not load providers. <button onClick={() => { setLoadError(null); setLoadAttempt(value => value + 1); }}>Retry</button></div>
      : !config ? <div className="provider-load-message" role="status">Loading…</div>
      : <>
        {configuredProviders.map(renderRow)}
        {availableProviders.length > 0 && <button type="button" className="provider-add-button" onClick={() => setShowAvailable(!availableVisible)} aria-expanded={availableVisible}>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${availableVisible ? 'rotate-180' : ''}`} />{availableVisible ? 'Hide available providers' : 'Add provider'}
        </button>}
        {availableVisible && availableProviders.map(renderRow)}
      </>}
  </ProviderSettingsSection>;
}
