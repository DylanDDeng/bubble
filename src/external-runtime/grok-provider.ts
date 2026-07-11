/** Canonical product/picker identity for the subscription-backed runtime. */
export const GROK_SUBSCRIPTION_PROVIDER_ID = "grok-subscription" as const;

/** Short command alias accepted by `/provider`, `/login`, and `/logout`. */
export const GROK_SUBSCRIPTION_COMMAND_ALIAS = "grok" as const;

export const GROK_SUBSCRIPTION_PROVIDER_NAME = "Grok Subscription" as const;
export const GROK_SUBSCRIPTION_PROVIDER_LABEL =
  "Grok Subscription [OAuth]" as const;

export const GROK_SUBSCRIPTION_PROVIDER = Object.freeze({
  id: GROK_SUBSCRIPTION_PROVIDER_ID,
  commandAlias: GROK_SUBSCRIPTION_COMMAND_ALIAS,
  name: GROK_SUBSCRIPTION_PROVIDER_NAME,
  label: GROK_SUBSCRIPTION_PROVIDER_LABEL,
});

export interface ExternalProviderPickerEntry {
  id: string;
  name: string;
  enabled: boolean;
}

export interface GrokSubscriptionPickerOptions {
  label?: string;
  enabled?: boolean;
}

/** Normalize only Grok's public command alias; unrelated provider IDs pass through. */
export function normalizeGrokSubscriptionProviderId(providerId: string): string {
  const candidate = providerId.trim().toLowerCase();
  if (candidate === GROK_SUBSCRIPTION_COMMAND_ALIAS || candidate === GROK_SUBSCRIPTION_PROVIDER_ID) {
    return GROK_SUBSCRIPTION_PROVIDER_ID;
  }
  return providerId;
}

export function isGrokSubscriptionProviderId(providerId: string | undefined): boolean {
  return providerId !== undefined
    && normalizeGrokSubscriptionProviderId(providerId) === GROK_SUBSCRIPTION_PROVIDER_ID;
}

/**
 * Append one canonical Grok row after native provider rows. Existing canonical
 * or command-alias rows are replaced, so independently composed picker lists
 * cannot show Grok twice. This helper is intentionally independent from
 * ProviderRegistry: Grok Subscription remains an external runtime.
 */
export function withGrokSubscriptionProvider(
  entries: readonly ExternalProviderPickerEntry[],
  options: GrokSubscriptionPickerOptions = {},
): ExternalProviderPickerEntry[] {
  const withoutGrok = entries.filter((entry) => !isGrokSubscriptionProviderId(entry.id));
  return [
    ...withoutGrok,
    {
      id: GROK_SUBSCRIPTION_PROVIDER_ID,
      name: options.label ?? GROK_SUBSCRIPTION_PROVIDER_LABEL,
      enabled: options.enabled ?? true,
    },
  ];
}
