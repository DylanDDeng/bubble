# Durable context compaction

## Implemented contract

- Session persistence no longer triggers lossy compaction at 180 entries.
- Automatic context decisions are made at Agent request boundaries using the model token budget. Server usage anchors already include tool schemas; schemas are not counted again on that anchored path.
- LLM summarization uses a model-window-aware input/output acceptance budget. Prior summaries and user constraints are protected input. If necessary, whole older assistant/tool groups are omitted with an explicit degradation notice. Heuristic fallback preserves bounded prior-summary prose and file operations.
- Semantic compaction creates a version-1 `context_checkpoint`: unique compaction ID, reason, source conversational revision, summary, and the exact retained conversational messages. The host system prompt is not stored in it. Active runtime reminders remain in Agent memory outside the durable projection; expired reminders are excluded from LLM summary input. Manual LLM compaction explicitly includes prior summaries.
- Commit appends and fsyncs the checkpoint before replacing Agent memory. A write failure, stale source revision, or cancellation does not publish the candidate or a durable-success event. Overflow recovery validates the smaller request before committing; it does not delete the original instruction as a last resort.
- Reopening uses the exact committed message projection plus subsequent entries. Same-turn continuations after a checkpoint retain completed tool groups and discard an incomplete group after a crash, even without a new user-message boundary. Original source entries remain in the archive. Metadata changes append instead of rewriting history. Explicit rewind still intentionally truncates history and removes later checkpoints; clear invalidates earlier checkpoints.
- Writes use owner-identified transaction locks. A dead owner can be recovered; a live owner is not expired based on elapsed time, but contenders wait for it with bounded backoff (2 s) before failing with a typed `SessionWriteLockBusyError`. Metadata records are full snapshots, so every metadata read-modify-write (`mutateMetadata`: update, title/runtime clears, goal persistence) refreshes, merges, and appends inside one lock transaction. Reads verify a stable file revision. A separate content-hashed log revision excludes metadata-only changes, task lifecycle audit markers, and provider diagnostics. Receipt supersession uses the same classification. TUI, Feishu, and SDK active-turn writes compare the resident history's conversational revision under the write lock; diagnostic/mode callbacks cannot legitimize foreign conversation changes. A rejected fenced write throws `SessionHistoryDivergedError`; every host rolls its resident history back to the file's truth on any refused write — divergence, busy lock, or I/O — reading the history first and adopting the revision of that same snapshot, so the refused message does not linger in the transcript and the next turn is not wedged behind the stale revision. The failed turn still terminates, with its terminal boundary and diagnostic recorded on the reloaded log.
- Resident checkpoints compact canonical history only, after a complete sibling-tool batch; pending tools cannot become persisted synthetic results. Projected runtime reminder blocks are excluded, while recognized summary carriers survive. Under heap pressure below the token threshold, the aggressively pruned candidate replaces resident memory only — no checkpoint is written and the log keeps full tool output. Tool-call IDs must be unambiguous within their own group, not across the checkpoint, because providers may scope IDs per response.
- Rewind refreshes, selects its target, and rewrites inside one lock transaction, so a manager that was idle during a foreign write rewinds the current log instead of failing after file checkpoints were already restored. It preserves the latest full metadata snapshot, including cleared fields, and removes titles whose source prompt was removed.
- LLM manual compaction replaces only the summary standing for the evicted input (`CompactResult.summaryIndex`); earlier multi-turn summaries in a sub-turn candidate's pre-turn survive verbatim.
- Memory extraction consumes effective checkpoint projections within clear-separated segments, prioritizes summaries and recent evidence within 70,000 characters, and versions its cache so previous extraction inputs are rebuilt.
- Old summary-only logs remain readable. Previously deleted originals cannot be recovered.

## Desktop behavior

A Bubble automatic-completion toast requires `persisted: true`, an active visible main session, and no parent tool ID. Checkpoint IDs deduplicate re-delivered completions. Historical, background, manual, failed, uncommitted, and child events do not produce this toast. Existing timeline boundaries and context-usage snapshots remain visible. Replayed boundaries preserve their first persisted timestamp and sort position while allowing payload updates.

## Verification

- `npm run build`
- `npx vitest run --exclude '**/.claude/**' --maxWorkers=4`: 243 files / 2241 tests passed in a clean PR worktree (unrelated OAuth changes excluded), 3 opt-in network probes skipped.
- `npm --prefix desktop run build`
- `npm --prefix desktop run verify:bubble-context`: typecheck, adapter/database reopen, helper/store notifications and isolated Electron ChatPane rendering.
- `npm --prefix desktop run verify:session-history`
- `npm --prefix desktop run verify:codex-compaction`
- `git diff --check`

Desktop verification requires a pre-existing baseline dependency, `desktop/src/electron/libs/runtime/`, which is currently ignored by `desktop/.gitignore` and absent from Git. The isolated verification checkout used a copy of that local directory; a fresh clone alone cannot currently transpile the desktop. This unrelated baseline packaging/source-tracking issue is not fixed by this PR; it is tracked separately in #77.

The Codex follow-up adds 25 core regressions plus SQLite replay/reopen assertions: real heap-pressure resident paths and sibling tools, host history fences and SDK callbacks, audit-only revisions, rewind metadata, large-archive extraction, clear segments, and cache version migration. The second review round adds typed divergence rejections with resident rollback, eviction-scoped manual compaction input, and call-id-paired compactor trimming. The third round adds locked metadata merges, bounded live-owner lock waits with host rollback on any refused write, snapshot-consistent revision adoption, index-scoped summary replacement, and refresh-under-lock rewind (`session-concurrency-regressions.test.ts`). The fourth round restores resident-only emergency pruning (a regression against the baseline) and group-scoped tool-call ID validation. The fifth round feeds the tail of an oversized pinned instruction (beyond the retained 8,192 characters) to the manual LLM summarizer, matching the heuristic path.

New tests cover exact single-turn tool-group restore, multi-checkpoint archive retention, clear/rewind, stale/idempotent receipts, failed writes, cancellation, terminated writer recovery, manual-plan invalidation, and a new SDK instance continuing from the committed checkpoint. Review regression tests additionally cover live/expired reminders, prior-summary carriers, same-turn crash suffixes, refresh races with foreign append/clear, lock-held revision checks, and local/foreign metadata-only updates during active replies or compaction. All providers are mocked; no production sessions or credentials are used.

## Remaining operational boundaries

This is a context-correctness change, not an archive-storage redesign. SessionLog still loads the JSONL archive into memory; disk segmentation, lazy indexes and archive retention quotas are not implemented here. Very long archives therefore still require a separate storage-capacity project. Full retained message snapshots also trade some disk space for exact replay.

A refused active-turn write rolls back the Agent's resident history, but events already streamed to an SDK consumer are not retracted: the desktop transcript may keep the rejected assistant text or tool-use card, followed by the error. This requires a foreign process writing the same session during an in-flight request; model context and the session log stay correct. Retraction needs a history-replaced SDK event plus desktop resync and is deferred.

`Provider.complete` has no server-side maximum-output argument. The compactor reserves output space, requests a bounded summary and rejects oversized output, but this is not a hard billing cap on the provider response. Manual desktop compaction remains the synchronous heuristic path; it now uses the same durable checkpoint contract rather than an LLM call.

This change does not package, install, publish, or restart the user's desktop application. New checkpoint logs should not be written with older Bubble builds that do not understand the new record type.
