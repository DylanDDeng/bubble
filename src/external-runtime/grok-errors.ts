export type GrokRuntimeErrorCode =
  | "unsupported_platform"
  | "binary_not_found"
  | "binary_untrusted"
  | "binary_version_mismatch"
  | "binary_hash_mismatch"
  | "profile_unsafe"
  | "profile_locked"
  | "preflight_failed"
  | "not_authenticated"
  | "protocol_error"
  | "policy_violation"
  | "process_crashed"
  | "cancelled"
  | "disposed";

export class GrokRuntimeError extends Error {
  readonly code: GrokRuntimeErrorCode;
  readonly diagnostic?: string;

  constructor(code: GrokRuntimeErrorCode, message: string, diagnostic?: string) {
    super(message);
    this.name = "GrokRuntimeError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof GrokRuntimeError) return error.message;
  return "Grok runtime is unavailable.";
}
