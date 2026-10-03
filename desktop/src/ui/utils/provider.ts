import { rendererStateStorage } from './renderer-state-storage';
import type { AgentProvider } from '../types';

export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [{ id: 'bubble', label: 'Bubble' }];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider { return 'bubble'; }

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, provider);
}
