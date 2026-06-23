import type { AgentProvider } from '../types';

// Bubble is the only agent. The 'aegis' slot is the built-in-agent vehicle.
export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'aegis', label: 'Bubble' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  return 'aegis';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, provider);
}
