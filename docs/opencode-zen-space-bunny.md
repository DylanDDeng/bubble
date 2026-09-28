# OpenCode Zen: Space Bunny Free

Verified on 2026-09-26.

| Field | Value | Source |
| --- | --- | --- |
| Display name | Space Bunny Free | Zen, models.dev |
| API model ID | `space-bunny-free` | Zen documentation and live `/models` |
| Bubble model ID | `opencode-zen:space-bunny-free` | Local provider registry |
| Endpoint | `https://opencode.ai/zen/v1/chat/completions` | Zen and live requests |
| Context window | 1,048,576 tokens | models.dev `opencode` entry |
| Maximum input / output | 524,288 / 524,288 tokens | models.dev; not stress-tested |
| Reasoning effort | `low`, `medium`, `high`, `xhigh`, `max` | models.dev |
| App default effort | `high` | Local default; not an advertised server default |
| Tool calling | Supported | models.dev and live tool round trip |
| Input / output modalities | Text, image, video / text | models.dev; live verification covers text only |
| Release date | 2026-09-23 | models.dev |
| Input, output, cache read prices | Free for a limited time | Zen pricing table |

Zen describes it as an anonymous preview model. The underlying vendor/model
identity is not published. Its documentation says the provider uses zero data
retention and does not train on submitted data. No free-period end date is given.

## Integration

Keep the existing Zen profile and API key. The profile may still declare
`openai-responses`: Bubble dispatches this model to Chat Completions for both
streaming and non-streaming requests, while Muse models continue to use
Responses. The Chat path uses the same proxy/CA-aware transport as Responses.

The desktop catalog includes its display name, context window and five effort
levels. Requests send `reasoning_effort`; unsupported inherited settings fall
back to the app default. Tool-call history preserves `reasoning_content`.
Usage is requested on streams, and the current free rates are included in cost
accounting. Modality and separate input/output limits above are upstream
metadata, not evidence that every desktop attachment format has been tested.

## Verification

- Same credential and model, minimal prompt: `/responses` returned HTTP 400,
  `ModelProtocolUnsupported`, `Model does not support this protocol.`
- `/chat/completions` returned HTTP 200 and `OK`.
- Built Bubble provider: streamed `OK` with usage; a real `echo_probe` tool call
  returned `bunny-check-73`, and the continuation repeated the tool result.
- Non-streaming completion with `max` effort returned `OK`.
- Unit regressions cover persisted Responses profiles, explicit Chat profiles,
  effort serialization, reasoning replay, zero pricing and unchanged Muse
  Responses behavior. Isolated Electron verification covers desktop catalog
  selection and context/effort metadata.

Sources:

- https://opencode.ai/docs/zen/
- https://opencode.ai/zen/v1/models
- https://models.dev/api.json (`opencode.models.space-bunny-free`)

## Opaque upstream 422 recovery

Zen sometimes returns `422 Upstream request failed: [invalid_request_error]
 unprocessable entity` during a tool conversation. Local session diagnostics
show successful continuations around these failures, but do not prove whether
upstream validation, routing, or a particular request shape caused them.

Bubble retries **only this error, provider and model combination**, with at most
2 retries after the initial request and abort-aware backoff. Streaming recovery
uses the agent's existing interruption path: discard incomplete output, repeat
the model request, and keep completed tool results. It does not rerun completed
tools or remove reasoning/history. Persistent failures still surface after the
budget; other validation errors remain nonretryable. Error records include only
allowlisted counts of messages, tools, reasoning and tool-result blocks, never
request text or credentials.

## Desktop performance verification (2026-09-26)

- Batch text/thinking deltas before the main-process event handlers and IPC,
  flushing at status, permission, error and content-block boundaries. A burst
  fixture preserved 216,000 characters while reducing 12,000 outgoing deltas to
  27. A 33 ms deadline keeps a slow/background stream updating.
- Desktop SDK session replay retains the latest 256 consumed events. Pending
  readers protect unread output; full conversation history remains persisted.
  Public SDK default replay remains unlimited. Expired cursors fail explicitly.
- Queue readiness scans only chats with queued/in-flight work, instead of all
  archived/idle chats on every streaming update.
- 150 focused provider/SDK tests passed, plus isolated Electron steer, queue,
  retry, tool-stream and adapter performance regressions.
- Real Electron ChatPane: 3,000 deltas / 327,000 reasoning characters preserved;
  at 15–25 seconds the renderer working set stabilized near 576 MiB. This is a
  bounded fixture, not a claim that every source of system lag is eliminated.
- Shared coalescer runtime tests passed. The old `verify-stream-perf.mjs`
  umbrella script still fails an existing startup-preload source assertion
  (`preloadClaudeAgentSdk` is already absent from HEAD); that unrelated check
  was not changed to manufacture a pass.

Build the SDK into a separate temporary `--outDir` and pass it explicitly to
`desktop/scripts/sync-bubble-sdk.mjs` while a TUI uses the root `dist` directory.
Do not run the root build or replace that directory under a running TUI.
