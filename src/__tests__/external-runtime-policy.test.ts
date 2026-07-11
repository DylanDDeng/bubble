import { describe, expect, it } from "vitest";
import {
  GROK_SUBSCRIPTION_COMMAND_ALIAS,
  GROK_SUBSCRIPTION_PROVIDER,
  GROK_SUBSCRIPTION_PROVIDER_ID,
  GROK_SUBSCRIPTION_PROVIDER_LABEL,
  isGrokSubscriptionProviderId,
  normalizeGrokSubscriptionProviderId,
  withGrokSubscriptionProvider,
} from "../external-runtime/grok-provider.js";
import {
  classifyExternalRuntimeBinding,
  shouldRejectGrokSessionInPrintMode,
  stopExternalRuntimeForSessionSwitch,
} from "../external-runtime/session-policy.js";
import { BUILTIN_PROVIDERS } from "../provider-registry.js";

describe("Grok Subscription provider descriptor", () => {
  it("uses a canonical picker ID while preserving the short command alias", () => {
    expect(GROK_SUBSCRIPTION_PROVIDER).toEqual({
      id: "grok-subscription",
      commandAlias: "grok",
      name: "Grok Subscription",
      label: "Grok Subscription [OAuth]",
    });
    expect(GROK_SUBSCRIPTION_PROVIDER_ID).toBe("grok-subscription");
    expect(GROK_SUBSCRIPTION_COMMAND_ALIAS).toBe("grok");
    expect(GROK_SUBSCRIPTION_PROVIDER_LABEL).toContain("OAuth");
    // The native "grok" registry provider intentionally matches the alias so
    // legacy picker rows and commands route to the same subscription login.
    expect(BUILTIN_PROVIDERS.some((provider) => isGrokSubscriptionProviderId(provider.id))).toBe(true);
  });

  it("normalizes the command alias and canonical picker ID without rewriting other providers", () => {
    expect(normalizeGrokSubscriptionProviderId("grok")).toBe("grok-subscription");
    expect(normalizeGrokSubscriptionProviderId(" Grok-Subscription ")).toBe("grok-subscription");
    expect(normalizeGrokSubscriptionProviderId("openai")).toBe("openai");
    expect(isGrokSubscriptionProviderId("grok")).toBe(true);
    expect(isGrokSubscriptionProviderId("grok-subscription")).toBe(true);
    expect(isGrokSubscriptionProviderId(undefined)).toBe(false);
  });

  it("appends one canonical picker row and deduplicates canonical or alias rows", () => {
    expect(withGrokSubscriptionProvider([
      { id: "openai", name: "OpenAI", enabled: true },
      { id: "grok", name: "old alias", enabled: false },
      { id: "anthropic", name: "Anthropic", enabled: true },
      { id: "grok-subscription", name: "old canonical", enabled: false },
    ])).toEqual([
      { id: "openai", name: "OpenAI", enabled: true },
      { id: "anthropic", name: "Anthropic", enabled: true },
      {
        id: "grok-subscription",
        name: "Grok Subscription [OAuth]",
        enabled: true,
      },
    ]);
  });

  it("supports context-specific picker labels without changing canonical identity", () => {
    expect(withGrokSubscriptionProvider([], {
      label: "Grok Subscription [local login]",
      enabled: false,
    })).toEqual([{
      id: "grok-subscription",
      name: "Grok Subscription [local login]",
      enabled: false,
    }]);
  });
});

describe("Grok Subscription session policy", () => {
  it("normalizes known IDs and fails closed for unknown external markers", () => {
    expect(classifyExternalRuntimeBinding(undefined)).toBe("none");
    expect(classifyExternalRuntimeBinding("grok")).toBe("grok");
    expect(classifyExternalRuntimeBinding("grok-subscription")).toBe("grok");
    expect(classifyExternalRuntimeBinding({ id: "grok" })).toBe("grok");
    expect(classifyExternalRuntimeBinding({ id: "grok-subscription" })).toBe("grok");
    expect(classifyExternalRuntimeBinding("future-runtime")).toBe("unsupported");
    expect(classifyExternalRuntimeBinding({ id: "future-runtime" })).toBe("unsupported");
    expect(classifyExternalRuntimeBinding({})).toBe("unsupported");
    expect(classifyExternalRuntimeBinding({ id: null })).toBe("unsupported");
    expect(classifyExternalRuntimeBinding(null)).toBe("unsupported");
  });

  it("rejects Grok-owned history in the native print path", () => {
    expect(shouldRejectGrokSessionInPrintMode({ id: "grok" }, true)).toBe(true);
    expect(shouldRejectGrokSessionInPrintMode({ id: "grok-subscription" }, true)).toBe(true);
    expect(shouldRejectGrokSessionInPrintMode({ id: "grok" }, false)).toBe(false);
    expect(shouldRejectGrokSessionInPrintMode(undefined, true)).toBe(false);
    expect(shouldRejectGrokSessionInPrintMode({ id: "openai" }, true)).toBe(true);
    expect(shouldRejectGrokSessionInPrintMode({ id: "future-runtime" }, true)).toBe(true);
    expect(shouldRejectGrokSessionInPrintMode({}, true)).toBe(true);
    expect(shouldRejectGrokSessionInPrintMode(null, true)).toBe(true);
  });

  it("propagates sidecar stop failures before a session switch can commit", async () => {
    const calls: string[] = [];
    const commitSwitch = () => { calls.push("commit"); };
    const runtime = {
      cancel: async (sessionId?: string) => { calls.push(`cancel:${sessionId}`); },
      dispose: async () => {
        calls.push("dispose");
        throw new Error("sidecar still alive");
      },
    } as any;

    await expect(
      stopExternalRuntimeForSessionSwitch(runtime, "session-1").then(commitSwitch),
    ).rejects.toThrow("sidecar still alive");
    expect(calls).toEqual(["cancel:session-1", "dispose"]);
    await expect(stopExternalRuntimeForSessionSwitch(undefined, "session-1"))
      .rejects.toThrow("current session was not changed");
  });
});
