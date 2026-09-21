# Durable context compaction

## Implemented contract

- Session persistence no longer triggers lossy compaction at 180 entries.
- Automatic context decisions are made at Agent request boundaries using the model token budget. Server usage anchors already include tool schemas; schemas are not counted again on that anchored path.
- LLM summarization uses a model-window-aware input/output acceptance budget. Prior summaries and user constraints are protected input. If necessary, whole older assistant/tool groups are omitted with an explicit degradation notice. Heuristic fallback preserves bounded prior-summary prose and file operations.
- Semantic compaction creates a version-1 `context_checkpoint`: unique compaction ID, reason, source conversational revision, summary, and the exact retained conversational messages. The host system prompt is not stored in it. Active runtime reminders remain in Agent memory outside the durable projection; expired reminders are excluded from LLM summary input. Manual LLM compaction explicitly includes prior summaries.
- Commit appends and fsyncs the checkpoint before replacing Agent memory. A write failure, stale source revision, or cancellation does not publish the candidate or a durable-success event. Overflow recovery validates the smaller request before committing; it does not delete the original instruction as a last resort.
- Reopening uses the exact committed message projection plus subsequent entries. Same-turn continuations after a checkpoint retain completed tool groups and discard an incomplete group after a crash, even without a new user-message boundary. Original source entries remain in the archive. Metadata changes append instead of rewriting history. Explicit rewind still intentionally truncates history and removes later checkpoints; clear invalidates earlier checkpoints.
- Writes use owner-identified transaction locks. A dead owner can be recovered; a live owner is not expired based on elapsed time. Reads verify a stable file revision. A separate content-hashed log revision excludes metadata-only changes, so asynchronous titles do not invalidate active contexts. SDK active-turn appends compare the caller's conversational revision under the same lock as the write; refreshing cannot legitimize a stale reply.
- Old summary-only logs remain readable. Previously deleted originals cannot be recovered.

## Desktop behavior

A Bubble automatic-completion toast requires `persisted: true`, an active visible main session, and no parent tool ID. Checkpoint IDs deduplicate re-delivered completions. Historical, background, manual, failed, uncommitted, and child events do not produce this toast. Existing timeline boundaries and context-usage snapshots remain visible.

## Verification

- `npm run build`
- `npx vitest run --exclude '**/.claude/**' --maxWorkers=4`: 239 files / 2216 tests passed in a clean PR worktree (unrelated OAuth changes excluded), 3 opt-in network probes skipped.
- `npm --prefix desktop run build`
- `npm --prefix desktop run verify:bubble-context`: typecheck, adapter/database reopen, helper/store notifications and isolated Electron ChatPane rendering.
- `npm --prefix desktop run verify:session-history`
- `npm --prefix desktop run verify:codex-compaction`
- `git diff --check`

New tests cover exact single-turn tool-group restore, multi-checkpoint archive retention, clear/rewind, stale/idempotent receipts, failed writes, cancellation, terminated writer recovery, manual-plan invalidation, and a new SDK instance continuing from the committed checkpoint. Review regression tests additionally cover live/expired reminders, prior-summary carriers, same-turn crash suffixes, refresh races with foreign append/clear, lock-held revision checks, and local/foreign metadata-only updates during active replies or compaction. All providers are mocked; no production sessions or credentials are used.

## Remaining operational boundaries

This is a context-correctness change, not an archive-storage redesign. SessionLog still loads the JSONL archive into memory; disk segmentation, lazy indexes and archive retention quotas are not implemented here. Very long archives therefore still require a separate storage-capacity project. Full retained message snapshots also trade some disk space for exact replay.

`Provider.complete` has no server-side maximum-output argument. The compactor reserves output space, requests a bounded summary and rejects oversized output, but this is not a hard billing cap on the provider response. Manual desktop compaction remains the synchronous heuristic path; it now uses the same durable checkpoint contract rather than an LLM call.

This change does not package, install, publish, or restart the user's desktop application. New checkpoint logs should not be written with older Bubble builds that do not understand the new record type.
