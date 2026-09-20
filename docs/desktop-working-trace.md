# Bubble desktop working trace

Bubble's trace uses a native event adapter and a Codex-style activity projection. The scope is the conversation's working trace, including its final-answer boundary, tools, reasoning, coordination, child agents, errors, media, disclosure and motion. It does not replace the desktop shell or add other providers to Bubble.

## Reference

The implementation was checked against the installed Codex App 26.915.31029 (9771), extracted read-only from `/Applications/Codex.app/Contents/Resources/app.asar`. The formatted inspection copies are under `/tmp/bubble-codex-trace-audit-u2cqkW`; no extracted bundle ships in Bubble.

Relevant native modules and behavior:

- `agent-activity-item-3801f7067f55.js`, `gn`: typed groupable / standalone classification.
- `agent-activity-units-48dc779bfb79.js`, `qe`, `Je`, `Ke`, `Ge`: chronological group boundaries, current activity / thinking / historical summary, single-item unwrapping, repeated successful MCP calls.
- `conversation-blocks-3f5612e1f0d0.js`, `fv`, `gv`, `vT`: disclosure lifecycle; activity identities; a 1,000 ms minimum interval for deferred header transitions; immediate terminal summaries.
- The same module, `E_`, `hx`: reference child lifecycle and coordination semantics. Bubble intentionally adapts their presentation to one persistent status row per child, as requested by the user.
- The same module, `NT`, `PT`: final-answer-triggered whole-work collapse, cancelled-turn preservation, persistent rich content outside hidden work.
- `local-conversation-turn-c6a6f94dc321.js`: latest reasoning heading as a thinking fallback, waiting-for-input status, native turn duration.
- `active-tool-activity-label-d04ce1947dd0.js`: active read/search/list/command labels use tool identity and structured action data.

Codex contains feature-gated alternatives. The user supplied `CleanShot 2026-09-20 at 02.09.59.mp4` (1478 × 1080, 60 fps, 59.916667 seconds), which resolves the reference-variant question without reading the Codex window. Observed anchors:

- 00 s: `Working for 16s` above a divider, no whole-turn chevron while tools run.
- 30 s: final answer streams below collapsed `Working for 47s`; the turn clock remains live.
- 48 s: completed `Worked for 40s`; backend duration supersedes the live estimate.
- 52 s: whole work expands to narration plus an icon-bearing `Read files, ran commands` group.
- 56 s: nine inline detail rows, no 14 rem scroll bound, approximately 28 px row pitch (24 px line + 4 px gap).
- 59 s: a read-file link opens the file in the right panel.

This follows the recorded unbounded activity-list variant (`cT` feature gate `1078255868`). The recording contains no child dispatch; child behavior is validated against extracted source and Bubble lifecycle replay. Bubble retains its theme palette and icon library. Successful command rows omit the collapsed chevron as recorded, while retaining click-to-inspect output as a Bubble adaptation; Codex's minimal-detail path suppresses raw command disclosure entirely. This is a source/recording-guided implementation, not a claim of pixel equality across the entire application shell.

## Event and presentation contract

1. Bubble's actual tool status, turn status and child status determine liveness. A failed earlier tool does not make a still-running turn look completed. A successful spawn does not complete its child.
2. Narration, errors, approvals, child operations and rich standalone tools break activity groups chronologically. Reasoning is filtered before activity grouping, so it cannot create an empty historical group or change a group's identity. Its latest heading feeds the turn-level thinking fallback. A reasoning-only live turn shows that status without a disclosure; a stopped turn leaves no phantom thinking row.
3. Only the latest open group owns the current action or thinking header. Earlier groups show completed summaries. A trailing exploration slice remains active between reads, including trailing reasoning events, as in Codex's `W`. Otherwise, without a pending operation, a live group uses the latest reasoning heading across the entire turn (including across narration boundaries), or `Thinking`.
4. A new active identity waits for the current header's one-second minimum display time. Updates within the same identity render immediately without remounting; a terminal summary bypasses the delay. Cleanup cancels obsolete timers.
5. Reads, searches, listings, commands and edits remain individual detail rows in the activity-group path. Completed reads link directly to the file; unfinished ordinary exploration has no empty detail row or chevron. Consecutive identical successful MCP calls can aggregate only when their qualified tool identity and displayed label match; every result remains available. Completed group summaries use the native unit-list separator. Exploration labels and icons share one classification across the group: reads use books, searches use a magnifier, listings use a folder, and mixed exploration uses a folder-search icon with “Explored project”, independent of call order.
6. A completed single activity unwraps its redundant group. A running group is collapsible independently of the whole turn if it has renderable details. Turn-owned manual choices survive hiding/reopening the work, pending-to-complete transitions, error transitions and single-item unwrapping.
7. A stable prompt timestamp owns the live `Working` / `Working for …` clock, refreshed once per second. Final-answer arrival allows whole-work collapse independently of turn liveness: the timer continues through answer streaming. A terminal result freezes it as `Worked for …` using recorded duration; missing completed duration uses the source-message count, and unknown live start stays `Working`. Stopped work without a final answer stays visible. Earlier interrupted tools do not prevent a recovered turn from collapsing.
8. Each child owns one row keyed by its spawn anchor: Creating → Queued / Working → Finished / Failed / Interrupted. The name opens the child panel; the adjacent disclosure reveals the task description. Internal wait calls remain in raw records, not ordinary child details. The child panel starts with the full dispatch instruction (long instructions are expandable), followed by its working trace and response. State changes preserve row identity and disclosure choice. Linked waits, including repeated timeouts, do not create additional main-trace rows. Unknown/partially linked targets and waits whose child row is outside the current turn remain independently inspectable. Token/activity timestamps never drive an age counter.
9. Raw wait records distinguish timeout, pending coordination and returned calls. `Wait returned` describes the call, not completion of every target: multi-target waits may return when only one child finishes. The child row always follows its own runtime state. Invocation targets are captured by the adapter using the same non-closed scope as the runtime; older implicit calls are associated with preceding spawns rather than current running status. Legacy records missing invocation targets, timestamps or spawn history are best-effort; unassociated calls remain inspectable instead of being silently discarded. A wait timeout ends that wait, not the child. Stopping the parent removes live waiting state.
10. Tool arguments/results, streamed command output, raw output, diffs and returned media remain inspectable. Generated media persists outside a collapsed completed trace.
11. Open activity lists remain fully visible, matching the recording. The reusable bounded scroll primitive still respects reader intent when used. Trace text uses 16 px scaled typography with 24 px line height; activity items use 16 px spacing, grouped details 4 px, and indented details 24 px. Activity disclosures use 300 ms height/opacity transitions with cubic-bezier(0.19, 1, 0.22, 1). Whole-work disclosure uses 220 ms entrance with -8 px translation and cubic-bezier(0.33, 1, 0.68, 1), and 150 ms exit with cubic-bezier(0.23, 1, 0.32, 1); reduced motion removes height/translation and uses a 120 ms fade on entrance. Shimmer begins after 600 ms, sweeps for 1 s in 48 steps, and repeats every 4 s only on the active header (not its expanded detail rows); reduced motion disables decorative animation. Keyboard activation, inert hidden content and theme variables are preserved.

## Files

Paths below are relative to `desktop/`:

- `src/ui/utils/activity-units.ts`: pure chronological projection, current header state and detail aggregation.
- `src/ui/utils/workstream.ts`: Bubble event normalization, stable reasoning identities, child-control targets.
- `src/ui/components/AssistantWorkstream.tsx`: activity groups, individual details, reasoning, child lifecycle and coordination.
- `src/ui/components/WorkstreamPrimitives.tsx`: identity-based header deferral, disclosure motion and scrolling.
- `src/ui/components/ToolExecutionBatch.tsx` and `src/ui/utils/transcript-timeline.ts`: final-answer boundary, duration and whole-work collapse.
- `src/ui/components/WorkstreamDisclosureState.tsx`: per-turn disclosure choices.

## Verification

Run `npm --prefix desktop run verify:codex-trace` from the repository root. It exercises pure activity projection, tool output parsing, real Electron React/ChatPane interactions, subagent protocol + lifecycle replay, narration order and duration. Renderer tests use temporary Electron profiles and a separate temporary `BUBBLE_HOME`, with OS-temporary caches outside Vite's watched source tree. The tests close their Electron and Vite processes.

The Electron checks cover current-state fallback, stable DOM identity, the 1,000 ms transition contract, cancellation of deferred updates, MCP aggregation with all results, raw output, live command output, manual disclosures, live turn clocks through final-answer collapse, authoritative completion duration, independent next-turn clocks, frozen history, unknown start timestamps, nine-row recording geometry, recovered/stopped turns, child/wait history, repeated timeouts, same-row lifecycle transitions, implicit target restoration, partially unknown targets, multi-target returns, mixed child outcomes, keyboard controls, scrolling, light/dark and 390 px windows. Screenshots are generated in `desktop/artifacts/subagent-visibility` and `desktop/artifacts/codex-trace`.

Build validation uses `npm run desktop:build`. This compiles the Agent and desktop renderer/main process; it does not package, install or release an application.

The optional `npm --prefix desktop run verify:codex-trace-reference` extracts only the audited pure state functions from the installed reference archive and compares 3,200 combinations of read/search/command/MCP/edit and pending/success/failure/interruption states, live/closed slices, and reasoning before/between/after the tools. It also checks native reasoning filtering, chronological group boundaries, individual exploration details and pending-detail visibility. It prints the source SHA256 and executes no Codex UI or application initialization code. This oracle intentionally uses ordinary filesystem operations; predicates for skill files, visualization commands and rich MCP apps are fixed false for that dataset. It is not evidence that all native feature-gated paths match. It is separate from portable CI because the reference application is not a project dependency.

## Completion audit

The implementation and local regression evidence must not be presented as proof of pixel-exact parity with the installed Codex window.

| Requirement | Authoritative evidence | Status |
| --- | --- | --- |
| Chronological grouping, current activity, reasoning and historical summaries | Native `gn`, `qe`, `W`, `Je`; differential oracle and actual React fixtures | Verified for the inspected ordinary-tool path |
| Stable activity identities and animation cadence | Native `gv`, `vT`, shimmer source; Electron DOM/timer assertions | Verified locally |
| Detail rows, direct file links and disclosure persistence | Native `cT`, `yT`, `Ky`, `lb`; Electron file-open and status-transition assertions | Verified locally |
| Final-answer collapse, stop/retry behavior and recorded duration | Native `NT`, `PT`; transcript, duration and real ChatPane replay tests | Verified locally |
| Child dispatch, lifecycle, wait, timeout, failure and history restoration | Native `E_`, `hx`; Bubble protocol/lifecycle tests and Electron replay | Verified for Bubble child events |
| Raw tool output, running output, diffs and persistent media | Tool-content tests and Electron trace fixtures | Verified locally |
| Keyboard, reduced motion, scroll reader intent and light/dark/Arc/narrow rendering | Electron interactions, computed styles and generated screenshots | Verified on Bubble |
| Agent/desktop compilation and no packaging | `npm run desktop:build` | Build gate; not a release |
| Recorded Codex variant: live timer, answer boundary, final duration, group summary, expanded rows and file link | User recording at 00/30/48/52/56/59 s; Electron clock, row geometry and file-open assertions; rendered screenshots | Verified for recorded trace states; Bubble palette/icons retained |

The recording supplies the previously missing visual reference. No Codex window inspection is needed. The implementation's regression gate covers the inspected source path and the recorded trace states; unrecorded experimental native paths and the surrounding desktop shell are outside this audit.

## Waiting strategy

The Agent's tool description, spawn next-step advice, timeout reply and lifecycle reminder now coordinate by task dependencies and decision value. Useful independent work can continue; wait when the child result blocks the next meaningful step or final synthesis. Short waits remain valid when they support a concrete scheduling decision. Status queries follow the same rule and are not a substitute polling loop. A timeout is an upper bound and completion wakes the caller early. No new minimum, changed default, or runtime scheduling policy is introduced. With multiple children, use explicit remaining IDs to avoid retrieving the same completed result repeatedly.
