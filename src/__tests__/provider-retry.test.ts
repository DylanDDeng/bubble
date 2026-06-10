import { describe, expect, it } from "vitest";
import {
  computeRetryDelayMs,
  getProviderMaxRetries,
  isProviderStreamInterruption,
  isRetryableHttpStatus,
  ProviderStreamInterruptedError,
  retryAfterMsFromResponse,
} from "../network/retry.js";

describe("provider retry policy", () => {
  it("defaults to 4 retries and accepts a clamped env override", () => {
    expect(getProviderMaxRetries({})).toBe(4);
    expect(getProviderMaxRetries({ BUBBLE_PROVIDER_MAX_RETRIES: "2" })).toBe(2);
    expect(getProviderMaxRetries({ BUBBLE_PROVIDER_MAX_RETRIES: "0" })).toBe(0);
    expect(getProviderMaxRetries({ BUBBLE_PROVIDER_MAX_RETRIES: "99" })).toBe(10);
    expect(getProviderMaxRetries({ BUBBLE_PROVIDER_MAX_RETRIES: "abc" })).toBe(4);
    expect(getProviderMaxRetries({ BUBBLE_PROVIDER_MAX_RETRIES: "-1" })).toBe(4);
  });

  it("classifies retryable HTTP statuses", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableHttpStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });

  it("parses retry-after headers in seconds", () => {
    const response = new Response("", { status: 429, headers: { "retry-after": "3" } });
    expect(retryAfterMsFromResponse(response)).toBe(3000);
  });

  it("returns undefined for missing or invalid retry-after headers", () => {
    expect(retryAfterMsFromResponse(new Response("", { status: 429 }))).toBeUndefined();
    expect(retryAfterMsFromResponse(new Response("", { status: 429, headers: { "retry-after": "soon" } }))).toBeUndefined();
  });

  it("returns zero delay under NODE_ENV=test", () => {
    expect(computeRetryDelayMs(1)).toBe(0);
    expect(computeRetryDelayMs(4, { retryAfterMs: 5000 })).toBe(0);
  });

  it("identifies stream interruption errors across wrapping", () => {
    const error = new ProviderStreamInterruptedError("stream died", { cause: new Error("socket closed") });
    expect(error.name).toBe("ProviderStreamInterruptedError");
    expect(isProviderStreamInterruption(error)).toBe(true);
    expect(isProviderStreamInterruption(new Error("stream died"))).toBe(false);
    expect(isProviderStreamInterruption(undefined)).toBe(false);
  });
});
