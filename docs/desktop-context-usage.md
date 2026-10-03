# Bubble desktop context usage

The context ring uses `system/bubble_context` snapshots from the runtime. Request preparation emits an estimate of the projected input, including tool definitions. After a response, provider input plus completion tokens replace that estimate. Cached input is already included in provider prompt tokens and is not added again.

The adapter still sums `turn_end.usage` for billing. A desktop `result.usage` is the sum of multiple model calls during one user turn, so it must never be divided by a context window to drive the ring. The tooltip labels this breakdown as the latest completed turn's consumption, separately from the latest context snapshot.

Automatic LLM compaction emits started and completed/failed events. Committed resident/subturn compaction and overflow recovery also emit completion events. Desktop maps them to `compact_status` / `compact_boundary`, persists the messages, and emits an estimated post-compaction context snapshot. The live compaction indicator remains visible even when a work trace already exists; a failed attempt clears it without inventing a successful boundary.

Manual compaction invalidates the old occupancy snapshot until another request provides fresh data. Opening an idle older desktop session recovers the latest individual inference usage from its bound native JSONL log under the active BUBBLE_HOME, using the matching desktop result only for model capacity. The synthesized snapshot has a stable identity and does not change database records, native files or pagination offsets. Recovery streams a bounded-size log without loading the SDK, calling a provider or scanning other sessions. Existing runtime snapshots (including explicit null invalidations) take priority. Compaction timestamps are compared with retained assistant timestamps, because a rewritten summary appears before older retained messages. Missing/corrupt logs, unavailable capacity, newer compaction/clear/model switches, external-runtime mirrors and running sessions remain unknown rather than restoring stale usage. A new runtime measurement supplies fresh data normally.

Verification:

- `npx vitest run src/__tests__/context-telemetry.test.ts src/__tests__/compaction-loop.test.ts src/__tests__/context-budget.test.ts src/__tests__/tui-context-info.test.ts`
- `npm --prefix desktop run verify:bubble-context` (after building the Agent): frontend calculation, adapter-generated events persisted/reopened in an isolated database, and actual ChatPane compaction/usage rendering with temporary profiles.
