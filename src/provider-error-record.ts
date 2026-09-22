import { getCurrentVersion } from "./update/index.js";
import type { ThinkingLevel } from "./types.js";

const MAX_FIELD_CHARS = 160;
const RUNTIME_STARTED_AT = Date.now();
const TRANSPORT_ERROR_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
]);
const SAFE_ERROR_CODES = new Map<string, string>([
  ["authentication_error", "authentication_error"],
  ["bad_request", "bad_request"],
  ["context_length_exceeded", "context_length_exceeded"],
  ["failed_precondition", "failed_precondition"],
  ["internal_error", "internal_error"],
  ["invalid_argument", "invalid_argument"],
  ["invalidparameter", "invalid_parameter"],
  ["invalid_parameter", "invalid_parameter"],
  ["location_not_supported", "location_not_supported"],
  ["permission_denied", "permission_denied"],
  ["rate_limit_exceeded", "rate_limit_exceeded"],
  ["rate_limit_exhausted", "rate_limit_exhausted"],
  ["resource_exhausted", "resource_exhausted"],
  ["service_unavailable", "service_unavailable"],
  ["timeout", "timeout"],
  ["unauthenticated", "unauthenticated"],
  ["unsupported_parameter", "unsupported_parameter"],
  ["unsupported_value", "unsupported_value"],
  ...Array.from(TRANSPORT_ERROR_CODES, (code): [string, string] => [code.toLowerCase(), code]),
]);
const SAFE_PARAMETER_NAMES = new Set([
  "contents",
  "frequency_penalty",
  "generationConfig",
  "input",
  "max_output_tokens",
  "max_tokens",
  "messages",
  "model",
  "n",
  "presence_penalty",
  "prompt",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "stream",
  "temperature",
  "thinkingConfig",
  "thinkingLevel",
  "thinking_level",
  "tool_choice",
  "tools",
  "topP",
  "top_p",
]);

export interface SanitizedProviderError {
  providerId: string;
  modelId: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  name: string;
  message: string;
  httpStatus?: number;
  code?: string;
  parameter?: string;
  messageCount: number;
  toolCount: number;
  bubbleVersion: string;
  pid: number;
  runtimeStartedAt: number;
  retry?: { attempt: number; maxAttempts: number };
}

export interface ProviderErrorContext {
  providerId: string;
  modelId: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  messageCount: number;
  toolCount: number;
  retry?: { attempt: number; maxAttempts: number };
}

/**
 * Build the allowlisted diagnostic record written to a session log.
 *
 * Deliberately do not serialize the original error object: SDK errors can
 * contain request headers, request bodies, response bodies and stacks. Only
 * scalar identifiers plus a locally-authored error category are retained.
 */
export function createSanitizedProviderError(
  error: unknown,
  context: ProviderErrorContext,
): SanitizedProviderError {
  const sources = errorSources(error);
  const rawMessage = firstString(sources, ["message"])
    || (typeof error === "string" ? error : "Provider request failed.");
  const httpStatus = firstHttpStatus(sources);
  // A wrapper's unknown code must not hide an allowlisted nested transport code.
  const code = sources.flatMap((source) => ["code", "errorCode", "type"].map((key) =>
    typeof source[key] === "string" ? sanitizeErrorCode(source[key]) : undefined,
  )).find((value) => value !== undefined);
  const parameter = sanitizeParameterName(firstScalarString(sources, ["param", "parameter"]));

  return {
    providerId: sanitizeControlledIdentifier(context.providerId),
    modelId: sanitizeControlledIdentifier(context.modelId),
    ...(context.model ? { model: sanitizeControlledIdentifier(context.model) } : {}),
    thinkingLevel: context.thinkingLevel,
    name: "ProviderError",
    message: code && TRANSPORT_ERROR_CODES.has(code)
      ? code.includes("TIMEOUT") || code === "ETIMEDOUT" ? "Provider request timed out." : "Provider connection failed."
      : sanitizeProviderErrorText(rawMessage),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(code ? { code } : {}),
    ...(parameter ? { parameter } : {}),
    messageCount: Math.max(0, Math.trunc(context.messageCount)),
    toolCount: Math.max(0, Math.trunc(context.toolCount)),
    bubbleVersion: getCurrentVersion(),
    pid: process.pid,
    runtimeStartedAt: RUNTIME_STARTED_AT,
    ...(context.retry ? { retry: {
      attempt: context.retry.attempt,
      maxAttempts: context.retry.maxAttempts,
    } } : {}),
  };
}

export function sanitizeProviderErrorText(value: string): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

  // Fail closed: provider/SDK messages can embed request headers, bodies,
  // prompts, URLs or credentials in formats a denylist cannot anticipate.
  // Persist only fixed, locally-authored summaries selected by broad error
  // categories; never return any substring copied from the provider message.
  if (/user location (?:is )?not supported|location[^.]{0,40}(?:unsupported|not supported)/i.test(text)) {
    return "User location is not supported for API use.";
  }
  if (/context[_ -]?(?:length|window)|prompt (?:is )?too long|maximum context|token limit/i.test(text)) {
    return "Provider context limit was exceeded.";
  }
  if (/rate limit|too many requests|quota|resource exhausted|\b429\b/i.test(text)) {
    return "Provider rate limit was exceeded.";
  }
  if (/unauthori[sz]ed|authentication|invalid (?:api )?key|missing (?:api )?key|\b401\b/i.test(text)) {
    return "Provider authentication failed.";
  }
  if (/forbidden|permission denied|access denied|\b403\b/i.test(text)) {
    return "Provider denied the request.";
  }
  if (/invalid[^.]{0,60}(?:parameter|argument)|unsupported[^.]{0,60}(?:parameter|argument)|bad request|\b400\b/i.test(text)) {
    return "Provider rejected a request parameter.";
  }
  if (/timed? ?out|timeout/i.test(text)) {
    return "Provider request timed out.";
  }
  if (/network|connection|socket|fetch failed|stream (?:closed|interrupted)/i.test(text)) {
    return "Provider connection failed.";
  }
  if (/abort|cancel/i.test(text)) {
    return "Provider request was cancelled.";
  }
  return "Provider request failed.";
}

function errorSources(error: unknown): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const pending = [error];
  const seen = new Set<object>();
  while (pending.length && sources.length < 12) {
    const source = asRecord(pending.shift());
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
    pending.push(source.error, source.cause);
  }
  return sources;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(sources: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function firstScalarString(sources: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
        return String(value).trim();
      }
    }
  }
  return undefined;
}

function firstHttpStatus(sources: Record<string, unknown>[]): number | undefined {
  for (const source of sources) {
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const value = source[key];
      const numeric = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
    }
  }
  return undefined;
}

function sanitizeControlledIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(normalized)) return "unknown";
  return normalized.slice(0, MAX_FIELD_CHARS);
}

function sanitizeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return SAFE_ERROR_CODES.get(value.trim().toLowerCase());
}

function sanitizeParameterName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return SAFE_PARAMETER_NAMES.has(normalized) ? normalized : undefined;
}
