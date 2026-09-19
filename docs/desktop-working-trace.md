# Bubble desktop working trace

The active implementation uses Aegis's workstream components with Bubble SDK events. It lives in `desktop/src/ui`; the previous standalone timeline implementation is archived in `desktop/legacy`.

## Presentation

- Each turn owns a chronological workstream. Narration and reasoning remain in order with tools.
- Adjacent compatible reads/searches, edits and commands become compact stages. Tool arguments and complete results are available through disclosure controls.
- Running work is visible; completed work collapses to a summary before the final answer. User disclosure choices persist through nested collapse/reopen.
- Errors, missing results and interruptions retain their own states. Imported history does not imply successful completion.
- Bubble subagent events use their actual flattened SDK shape and attach child progress to the correct parent tool.

## Main files

- `src/ui/components/AssistantWorkstream.tsx`: narration, stages and tool result presentation.
- `src/ui/components/ToolExecutionBatch.tsx`: completed work disclosure and duration.
- `src/ui/components/WorkstreamDisclosureState.tsx`: turn-owned disclosure state.
- `src/ui/utils/workstream-stages.ts`: ordered stage projection.
- `src/electron/libs/provider/bubble-sdk-adapter.ts`: local SDK stream adaptation, permissions and subagents.
- `src/electron/libs/bubble-history-import.ts`: persisted Bubble JSONL adaptation. Missing message timestamps use the session timestamp instead of inventing elapsed tool durations.

Paths above are relative to `desktop/`. `npm run desktop:test` checks stages, preamble order, duration, session history, subagent protocol and actual local SDK execution. No application packaging is performed.

The earlier read-only Codex archive inspection informed progressive disclosure and command summary behavior. The shipped implementation is based on the MIT-licensed Coworker/Aegis source and Bubble's own runtime; it contains no extracted Codex bundle code.
