# Provider transport diagnostics

OpenAI Codex transport failures are recorded by default in
`$BUBBLE_HOME/logs/provider-transport.jsonl` (normally
`~/.bubble/logs/provider-transport.jsonl`, or `~/.bubble-dev/logs/` for dev).
`BUBBLE_TRACE` is not required. At 2 MiB the file rotates to `.jsonl.1`,
replacing the previous backup. Logging is best-effort and cannot fail a turn.

Each failure records the timestamp, PID, model, locally generated provider
session/request IDs, transport attempt number, HTTP response status when known,
parsed SSE event count, elapsed time, time since the last parsed event, and the
decision (`retry`, `delegate_retry`, `fail`, or `cancelled`). The IDs are local
correlation IDs, not server request IDs or desktop task IDs. Transport attempt
numbers restart when the Agent reissues a model request. `delegate_retry` means
the Agent owns the retry decision; its budget may already be exhausted.

Only allowlisted error codes and fixed summaries are retained. Request headers,
tokens, prompts, streamed content, and raw exception stacks are not recorded.
For example, Node's `TypeError: terminated` with a nested `SocketError` is
recorded as `UND_ERR_SOCKET` / `Provider connection failed.`. This identifies a
transport failure, but does not by itself identify which network hop closed it.

Session JSONL `provider_error` entries also retain nested transport codes.
Retried stream errors include `retry: { attempt, maxAttempts }`; a terminal
failure has no `retry` field. These entries are diagnostic-only and do not enter
model history or change its conversational revision.

Connection failures before a parsed SSE event use the configured provider retry
budget (default four retries). Mid-stream failures use the Agent's existing two
retries, discarding partial assistant/tool-call data before reissuing the request.
User cancellation does not retry. Tools are executed only after a complete model
response, so incomplete streamed tool arguments must not execute.

Regression coverage: `codex-socket-recovery.test.ts` uses an actual local HTTP
server that closes SSE sockets, including SDK persistence, incomplete tool calls,
retry exhaustion, and user cancellation. `provider-transport-log.test.ts` covers
redaction, rotation, and write failures.
