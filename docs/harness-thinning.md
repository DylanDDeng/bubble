# Harness Thinning — Wave 1: remove the cognitive governance layer

Status: **design final** (3-agent adversarial review incorporated, 2026-07-29).
The commit that adds this document is the last commit WITH the governance
layer — it is the "governance on" arm for any future A/B comparison
(A/B discipline: no lockfile is committed, so both arms must reuse the same
node_modules; `npm run build` after each checkout).

## Philosophy

Modeled on earendil-works/pi's core stance: **mechanism stays, policy ships
empty**. The ruler for every line of harness code:

> Input is "the model's behaviour", output is "a judgement / correction /
> substitution of that behaviour" → delete.
> Supplies facts the model cannot see / guards authority boundaries /
> resource fuses / infrastructure → keep.

Hard constraint: subagent and dynamic-workflow functionality is preserved in
full (spawn/wait/send/close, run_workflow QuickJS runtime, background
workflows, scheduler, ChildRunner, worktrees, profiles, subtask-policy,
router resolve/validate, cross-process resume). Verified at import-graph
level: none of those modules import anything deleted here.

## What goes (wave 1)

Modules (+ their tests): task-classifier, execution-governor,
discovery-barrier, evidence-tracker, tool-arbiter, task-size,
orchestrator/workflow.ts (the security phase machine — NOT
src/agent/workflow/, which is the preserved QuickJS runtime and merely
shares the name).

Wiring: all governance blocks in orchestrator/default-hooks.ts (classifier /
governor / barrier / evidence / arbitration / task-type reminders /
small-task hint / large-task delegation checkpoint / completion gate's
self-check lecture); agent.ts steer-path classifyTask, barrier stream
buffering + orderToolCalls + hidden-result branches (helpers moved, not
deleted); §6 routing-downgrade detector at BOTH ends (router state +
runtime noteDispatch calls + agent facade + default-hooks consumption);
edit-retry escalation nagging; ~10 now-dead TurnHookState fields;
arbiterNote metadata type; dead reminder builders in prompt/reminders.ts;
reminderForTaskType + largeImplementationTaskReminder in task-reminders.ts
(the file itself stays — orchestrationRequestReminder and
userNamedModelReminder live there and are kept).

## What stays, and why

- TurnHooks mechanism itself (pi-style empty hook surface).
- The reminder queue/flush pipeline (renamed from flushGovernorReminders —
  it is the delivery channel for ALL reminders, not a governor part).
- Subagent lifecycle + background-task reminders (facts the model cannot
  otherwise see).
- orchestrationRequestReminder — honest label: this is deliberately retained
  POLICY (amplifies the user's explicit orchestration request; July lesson:
  wording alone loses to model priors). userNamedModelReminder — mostly
  information (deterministic catalog resolution of a user-named model).
- modifiedExistingTests disclosure — kept, stripped out of the deleted
  completion gate: git-ground-truth fact ("this run touched existing test
  files") that bash writes and subagent worktree merges hide from the
  model's own tool memory; guards against green-by-editing-tests.
- change-tracker.ts (powers the -p mode change summary, a user feature, via
  main.ts's own independent baseline).
- tool-intent.ts (bash/grep tool metadata producers; child-runner tool
  notes and TUI trace grouping consume the parses — wave 2 may slim the
  now-readerless searchSignature/searchFamily fields).
- internal-reminder-sanitizer (legacy patterns kept: they clean historical
  session logs).
- subtask-policy (capability config for spawn profiles; note: its taskBudget
  / resultStatus fields are currently dead weight — wave 2 candidate).
- buildToolFreezeReminder + maxTurns / concurrency caps (resource fuses;
  note: the only live freeze trigger today is maxTurns).
- run_workflow exclusive-call rule (contract shape, not behaviour judgement).
- approval / worktree fence (authority layer — Bubble's hosts cannot ask
  users to containerize, unlike pi's audience).

## Execution: three commits

A. Pure move: isHiddenToolResult / isHiddenToolMetadata out of
   discovery-barrier into a neutral module (agent.ts and tui-ink consume
   them; the mechanism outlives the barrier).
B. Sever wiring: every behaviour change lands here, delete-lines-only in
   kept files (no reordering of surviving statements); test surgery for
   shared test files (agent.test.ts, delegation-policy, model-routing,
   internal-reminder-sanitizer).
C. Delete orphans: the module files + wholly-governance test files
   (execution-governor, task-classifier, discovery-barrier, task-size,
   tool-arbiter, workflow.test.ts, completion-gate.test.ts,
   large-task-nudge.test.ts).

Verification per step: tsc + full vitest; after C additionally: repo-wide
grep for every deleted symbol = 0, `npm run build`, `-p --output-format
json` smoke (changes block intact), TUI smoke including
spawn→wait→send_input→close and a background run_workflow.

Expected net deletion: ~2,300+ lines including tests.

## Wave 2 (recorded, not in scope)

System-prompt thinning (exploration-first protocol text), tool-intent /
metadata fossils (searchSignature/searchFamily), bash.ts parse
simplification, subtask-policy dead fields, tool prompt-cost review,
run_workflow exclusive rule re-review, forceContinuationReason mechanism
(left as an intentionally empty hook capability by wave 1).
