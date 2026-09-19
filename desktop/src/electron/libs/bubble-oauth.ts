import { app, shell, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { BubbleOAuthState } from '../../shared/types';
import { getBubbleSdk, reloadBubbleSdkConfig } from './provider/bubble-sdk-loader';
import { authorizationUrlFromStatus, validOAuthTokens } from './bubble-oauth-protocol';

let state: BubbleOAuthState = { status: 'idle', providerId: null, canReopen: false };
let pending: { worker: UtilityProcess; timer: NodeJS.Timeout; providerId: string; ownerId: number; url?: string } | undefined;

export function getBubbleOAuthState(): BubbleOAuthState { return { ...state }; }

function stopWorker() {
  const attempt = pending;
  pending = undefined; // ignore late callbacks before killing the process
  if (attempt) {
    clearTimeout(attempt.timer);
    attempt.worker.kill();
  }
}

export function cancelBubbleOAuth(ownerId?: number): BubbleOAuthState {
  if (ownerId !== undefined && pending?.ownerId !== ownerId) return getBubbleOAuthState();
  stopWorker();
  state = { status: 'idle', providerId: null, canReopen: false };
  return getBubbleOAuthState();
}

export async function reopenBubbleOAuth(): Promise<void> {
  if (pending?.url) await shell.openExternal(pending.url);
}

export function startBubbleOAuth(providerId: string, ownerId: number, onComplete?: () => void): BubbleOAuthState {
  if (providerId !== 'openai' && providerId !== 'grok') throw new Error('This provider does not support subscription sign-in.');
  if (pending) throw new Error('A sign-in is already in progress. Finish or cancel it first.');
  const worker = utilityProcess.fork(join(__dirname, 'bubble-oauth-worker.js'), [app.getAppPath(), providerId], {
    serviceName: 'Bubble subscription sign-in', stdio: 'pipe', env: { ...process.env },
  });
  // Do not let SDK diagnostics or token-exchange errors enter desktop logs.
  worker.stdout?.resume();
  worker.stderr?.resume();
  const attempt = { worker, providerId, ownerId, timer: setTimeout(() => fail('Sign-in timed out. Please try again.'), 310_000), url: undefined as string | undefined };
  pending = attempt;
  state = { status: 'pending', providerId, canReopen: false, phase: 'authorizing' };
  function fail(error: string) {
    if (pending !== attempt) return;
    stopWorker();
    state = { status: 'error', providerId, canReopen: false, error, phase: state.phase };
    // Error is sanitized in the worker; never log a token response or callback URL.
    console.warn('[bubble-oauth]', { providerId, phase: state.phase, error });
  }
  worker.on('exit', () => fail('The sign-in process stopped. Please try again.'));
  worker.on('message', async (message: { type?: string; url?: string; tokens?: unknown; error?: string }) => {
    if (pending !== attempt) return;
    if (message?.type === 'authorization-url' && typeof message.url === 'string') {
      const url = authorizationUrlFromStatus(providerId, message.url);
      if (url) { attempt.url = url; state = { ...state, canReopen: true }; }
    } else if (message?.type === 'exchanging') {
      attempt.url = undefined;
      state = { ...state, phase: 'exchanging', canReopen: false };
    } else if (message?.type === 'error') {
      // The worker has already reduced the SDK error to credential-free copy.
      fail(message.error || 'Sign-in failed. Please try again.');
    } else if (message?.type === 'success') {
      if (!validOAuthTokens(message.tokens)) { fail('The provider returned incomplete credentials. Please sign in again.'); return; }
      state = { ...state, phase: 'saving', canReopen: false };
      try {
        const sdk = await getBubbleSdk();
        if (pending !== attempt) return;
        reloadBubbleSdkConfig(sdk);
        const tokens = message.tokens;
        // Save through the registry's own storage, preserving refresh locking,
        // routing-cache invalidation and the selected profile's BUBBLE_HOME.
        sdk.registry.getAuthStorage().set(providerId, { type: 'oauth', ...tokens });
        const providers = sdk.userConfig.getProviders();
        const existing = providers.find(entry => entry.id === providerId);
        if (existing) { existing.enabled = true; sdk.userConfig.setProviders(providers); }
        stopWorker();
        state = { status: 'success', providerId, canReopen: false };
        onComplete?.();
      } catch {
        fail('Could not save the sign-in in this data environment. Please try again.');
      }
    }
  });
  return getBubbleOAuthState();
}
