# Bubble TUI rewrite on vendored pi-tui

Status: **approved direction; implementation not started**  
Branch: `rewrite/pi-tui`  
Decision date: 2026-08-18

## 1. Decision

Bubble will replace the current React/Ink terminal UI with a new product UI built on a repository-owned fork of:

- Upstream: <https://github.com/earendil-works/pi>
- Imported subtree: `packages/tui`
- Initial pinned commit: `e5dde9a76bfec3c4eff764d1b6db3b60e5dd0b30`
- Package version at that commit: `@earendil-works/pi-tui@0.84.2`
- License: MIT, copyright 2025 Mario Zechner

The imported renderer will live in Bubble's repository and be maintained by Bubble, following the broad model used by Kimi Code: upstream code is vendored, renderer fixes are made at the renderer layer with deterministic terminal tests, and product-specific UI stays outside the renderer package.

This is a full replacement, not an Ink resize patch and not a permanent dual-TUI product. Development happens on the dedicated rewrite branch. The old implementation may remain in that branch as a behavior reference until the final cutover, but Bubble will not ship a user-facing `ink|pi` selector or maintain two production TUIs.

The final cutover removes:

- `src/tui-ink/**`
- the `ink`, `react`, and `@types/react` production dependencies
- JSX configuration needed only by the old TUI
- Ink-specific `<Static>`, Yoga measurement, cursor-compensation, and stdout repaint workarounds

## 2. Why this is a renderer replacement

Bubble already owns terminal behavior that sits below ordinary product components:

- primary-screen transcript and native scrollback
- dynamic streaming tail versus committed history
- terminal resize and transcript reflow
- synchronized output
- cursor placement and IME-sensitive editor behavior
- CJK, emoji, and ambiguous-width measurement
- raw input, Kitty keyboard events, bracketed paste, and mouse parsing
- full redraws for clear, compact, rewind, session switch, and theme changes

The current Ink implementation compensates for renderer behavior by clearing the screen and scrollback, changing `<Static>` generations, measuring Yoga nodes, and resetting stale cursor-layout references. These mechanisms are the direct source of several resize and split-pane defects.

The new design gives Bubble an explicit terminal renderer with a document, viewport anchor, frame diff, hardware cursor, and terminal lifecycle. It does not rely on React reconciliation or terminal scrollback as application state.

## 3. Non-goals

The rewrite will not:

- fork the Agent, provider, session, MCP, skill, goal, or process-manager data models
- change session JSONL or metadata formats
- redesign keyboard shortcuts during migration
- change permission semantics, queue/steer behavior, or slash-command behavior
- switch Bubble to an alternate-screen-only application
- ship a permanent fallback to Ink
- copy Kimi Code's product UI or event schema
- put Bubble-specific provider/session logic inside the vendored renderer

Visual cleanup is allowed only when needed to express an existing interaction in pi-tui. Broad visual redesign happens after parity and terminal correctness are complete.

## 4. Renderer mode and terminal contract

Bubble will use pi-tui's **main-screen renderer** (`TuiMainScreen`) as the default architecture.

Required terminal behavior:

1. Native terminal scrollback remains available.
2. Users can select and copy completed assistant output with the terminal.
3. tmux copy mode remains useful.
4. Streaming output and the composer occupy a live region managed by the renderer.
5. A resize re-renders from application state without duplicating committed output.
6. Viewport/scrollback anchors never move backward during ordinary append or streaming oscillation.
7. Full redraw is an explicit exceptional operation, not the default response to every UI state change.
8. Exit always restores raw mode, cursor visibility, synchronized-output mode, bracketed paste, Kitty keyboard state, mouse state, and autowrap.
9. The shell prompt starts on a clean line after orderly exit, cancellation, SIGTERM, SIGHUP, or a fatal error.

`TuiAltScreen` is not the primary renderer for this rewrite. It can be evaluated later for an optional fullscreen experience, but it is outside this project because it changes scrollback, selection, and copy semantics.

## 5. Repository shape

Target structure:

```text
packages/
  pi-tui/
    package.json
    README.md
    LICENSE
    UPSTREAM.md
    DOWNSTREAM_PATCHES.md
    src/
    test/
    native/

src/
  tui/
    run.ts
    run-session-picker.ts
    application.ts

    controller/
      controller.ts
      state.ts
      snapshot.ts
      intents.ts
      effects.ts
      ports.ts
      agent-event-reducer.ts
      session-transition.ts
      overlay-controller.ts
      task-runtime-controller.ts

    components/
      transcript/
        transcript.ts
        message.ts
        user-message.ts
        assistant-message.ts
        reasoning.ts
        tool-trace.ts
        edit-diff.ts
        compaction.ts
        subagent.ts
      composer/
        composer.ts
        completions.ts
        attachments.ts
      chrome/
        welcome.ts
        footer.ts
        waiting.ts
        progress.ts
      overlays/
        approval.ts
        question.ts
        plan-confirm.ts
        feedback.ts
        model-picker.ts
        provider-picker.ts
        command-palette.ts
        session-picker.ts
        rewind-picker.ts
        stats.ts
        subagent-inspector.ts
        feishu-setup.ts

    model/
      display-history.ts
      display-reconstruct.ts
      composer-buffer.ts
      input-history.ts
      input-queue.ts
      trace-groups.ts
      subagent-view.ts
      theme.ts

    terminal/
      terminal.ts
      lifecycle.ts
      capabilities.ts

    formatting/
      width.ts
      markdown.ts
      code-highlight.ts
      edit-diff.ts

    testing/
      fake-agent.ts
      fixtures.ts
      terminal-harness.ts
```

During development, `src/tui-ink` remains untouched except when product logic is deliberately extracted into renderer-neutral modules. At final cutover it is deleted as one explicit operation.

## 6. Vendored pi-tui boundary

### 6.1 What belongs in `packages/pi-tui`

The vendored package owns generic terminal infrastructure:

- process terminal abstraction
- raw input and escape-sequence buffering
- key decoding and keybindings
- main-screen and alternate-screen renderers
- differential rendering and synchronized output
- viewport and scrollback-anchor bookkeeping
- hardware cursor placement
- overlays and focus dispatch primitives
- ANSI-aware width, truncation, and slicing
- generic `Text`, `Box`, `Container`, `VStack`, `HStack`, `ScrollView`, `Editor`, `Input`, `Markdown`, `SelectList`, `SettingsList`, `Loader`, and image components
- platform-native input helpers supplied by upstream
- FakeTerminal and xterm-headless renderer tests

### 6.2 What must not enter `packages/pi-tui`

The renderer must not import or know about:

- `Agent`
- `SessionManager`
- providers or models
- MCP or skills
- goals or loops
- Bubble permission modes
- Bubble tool schemas
- subagent/workflow event formats
- Grok external runtime
- Bubble config or memory

If a product feature appears to need a renderer change, first define the generic renderer capability and its renderer-level test. Bubble-specific behavior remains an adapter or component under `src/tui`.

### 6.3 Local package identity

The vendored package will be renamed to `@bubblebrain-ai/pi-tui` while preserving upstream author, repository, copyright, and MIT license metadata. It is repository-owned and initially private to Bubble's build.

The exact npm packaging method is a Phase 1 gate, not an assumption. The preferred shape is an npm workspace package bundled into Bubble's published tarball. The gate must prove that a clean install of `npm pack` output contains the compiled renderer and platform native helpers. If npm workspace bundling cannot satisfy this reliably, the fallback is to compile the vendored source into Bubble's `dist/vendor/pi-tui` while retaining the source subtree and upstream metadata in `packages/pi-tui`.

Bubble must not depend at runtime on an unpinned GitHub URL or fetch renderer source during build/install.

## 7. Upstream maintenance policy

`packages/pi-tui/UPSTREAM.md` records:

```text
Repository: https://github.com/earendil-works/pi
Subtree: packages/tui
Tag/version: 0.84.2
Commit: e5dde9a76bfec3c4eff764d1b6db3b60e5dd0b30
Imported at: <date>
License: MIT
Local package: @bubblebrain-ai/pi-tui
```

`DOWNSTREAM_PATCHES.md` records every Bubble renderer patch:

- patch identifier and commit
- reason and production symptom
- files touched
- associated FakeTerminal/xterm/PTY regression
- whether it has been or can be submitted upstream
- replay or merge risk during the next sync

Rules:

1. Initial import is a mechanical subtree import at the pinned SHA.
2. The upstream package tests must pass before Bubble modifications.
3. Renderer patches are separate commits from Bubble product UI commits.
4. Upstream sync commits contain only upstream changes:
   `vendor(pi-tui): sync upstream packages/tui at <sha>`.
5. Reapplied Bubble patches are separate commits.
6. Product code never edits vendored files as part of an unrelated feature.
7. Every renderer bug fix starts with a failing terminal-level reproduction.
8. No upstream sync occurs during the parity-critical final cutover window.

## 8. Application architecture

### 8.1 Controller

The current `src/tui-ink/app.tsx` mixes runtime orchestration and rendering. The replacement has one long-lived controller independent of pi-tui components:

```ts
interface BubbleTuiController {
  getSnapshot(): BubbleTuiSnapshot;
  subscribe(listener: (snapshot: BubbleTuiSnapshot) => void): () => void;
  dispatch(intent: BubbleTuiIntent): void;
  shutdown(reason: ShutdownReason): Promise<TuiExitSummary>;
}
```

The controller owns:

- Agent and external-runtime event consumption
- streaming text/reasoning/tool aggregation
- the 40 ms display flush policy
- submit, queue, steer, interrupt, and queued-turn drain
- session switch as a transaction
- model/provider/thinking/permission changes
- slash-command actions
- plan/approval/question Promise lifecycle
- goal continuation, loop scheduling, and task wake
- background task and subagent snapshots
- stale runtime generation isolation
- persistence side effects
- orderly shutdown

The controller produces immutable snapshots. It does not return terminal lines and does not call renderer APIs directly.

### 8.2 Input routing

One explicit input router replaces distributed Ink `useInput` handlers:

```text
terminal decoder
  -> global lifecycle shortcuts
  -> active overlay
  -> focused component
  -> composer
```

Rules:

- one key event is consumed by at most one layer
- release events cannot produce text
- modal Enter/Esc cannot leak into the composer
- Ctrl+C follows a documented state machine: cancel active run, close eligible overlay, or exit
- focus restoration after overlay dismissal is deterministic
- pending plan/approval/question requests are always resolved or rejected on teardown

### 8.3 Renderer

The renderer subscribes to snapshots and maps them to pi-tui components. Components may cache rendered lines, but they do not own Agent/session truth.

```text
Agent/session/managers
        -> controller state
        -> immutable snapshot
        -> Bubble pi-tui components
        -> pi-tui document/frame
        -> differential terminal paint
```

Terminal resize is a renderer event. It invalidates width-sensitive line caches and repaints the visible document. It does not mutate the transcript, session, or Agent state.

### 8.4 Session transition

Session switch is atomic from the UI's point of view. A successful transition changes all of the following together:

- active `SessionManager`
- Agent session ID and provider binding
- transcript projection
- queue/steer ownership
- composer draft/history scope
- external-runtime generation
- live subagent accumulator
- task ownership view
- footer metadata

A failed transition leaves the previous session usable. No intermediate mixed-session snapshot is published.

### 8.5 Blocking interaction lifecycle

Plan, approval, and question requests are modeled as owned overlay requests with one terminal state:

```text
pending -> accepted | rejected | cancelled | disposed
```

Session switch, app shutdown, fatal error, and overlay replacement must explicitly settle pending requests. The Agent must never remain blocked on a Promise whose view disappeared.

## 9. Feature parity matrix

The rewrite is not complete until these behaviors are implemented and tested.

### 9.1 Terminal lifecycle

- primary-screen operation and native scrollback
- synchronized output
- resize without duplicate transcript or stale lines
- suspend/resume
- cursor and raw-mode restoration
- Kitty keyboard protocol push/pop
- bracketed paste
- terminal theme detection
- clean fatal/SIGTERM/SIGHUP exit
- startup `--resume` picker lifecycle

### 9.2 Composer

- multiline editing and visual cursor movement
- readline-style word/line movement and deletion
- Enter submit and modified-Enter newline
- history navigation and draft restoration
- long-paste collapsing with lossless submission
- long-paste history recall and re-collapse
- asynchronous paste completion gating
- slash-command and skill completion
- `@file` completion and expansion
- image clipboard/path ingestion and labels
- queue and steer while Agent is running
- duplicate-submit suppression
- constrained external-runtime policy
- CJK/emoji/combining-character cursor correctness
- IME candidate positioning through the real hardware cursor

### 9.3 Transcript and streaming

- text/tool/text chronological ordering
- partial text and reasoning streaming
- partial tool argument display
- tool progress and completion updates
- retry removal of abandoned partial attempts
- `willContinue` multi-turn commit behavior
- cancellation retaining valid partial output
- hidden internal interruption/reminder content
- Markdown, code fences, tables, lists, and inline code
- CJK/emoji/ambiguous-width wrapping
- tool grouping and collapse policies
- edit/write diff previews
- compaction boundaries and summaries
- cross-round subagent updates
- native selection/copy of completed history

### 9.4 Overlays and pickers

- plan confirmation/edit/reject
- tool approval and diff preview
- multi-question dialog
- feedback
- command palette
- model/provider/key/login/logout selection
- reasoning effort selection and persistence
- theme selection and overrides
- skill selection
- MCP reconnect
- runtime and startup session pickers
- rewind scope picker
- stats panel
- subagent/task inspector and task kill
- Feishu setup

### 9.5 Runtime integrations

- native Agent and Grok external runtime
- provider/model preflight without corrupting live Agent state
- permission-mode switching
- context usage updates
- goals and hidden continuation turns
- loop scheduling
- background task promotion and wake
- queue drain
- update notice
- memory commands
- MCP and LSP-dependent commands
- hook lifecycle

## 10. Test architecture

### 10.1 Pure unit tests

Renderer-neutral logic should retain or gain direct tests:

- composer buffer and paste spans
- input history and queue ownership
- display-history accumulation
- display reconstruction and reminder filtering
- Agent event reducer
- trace grouping and diff formatting
- model picker ranking and stable selection
- subagent projection
- theme palette
- session transition transaction
- overlay Promise lifecycle
- task/goal/loop scheduling gates

Existing `ink-*` tests are not deleted merely because their renderer changes. Their behavior contracts are moved to renderer-line or terminal-screen tests. Ink-specific workaround tests, such as Yoga cursor row compensation, are replaced by tests of the user-visible cursor behavior.

### 10.2 Renderer tests

Use pi-tui `FakeTerminal` tests for deterministic frame assertions:

- append-only output
- in-place live-region updates
- content growth and collapse
- width and height changes
- viewport anchor monotonicity
- exactly-once scrollback commit
- full redraw residue
- hardware cursor bookkeeping
- overlay focus and dismissal
- very narrow terminals
- ANSI and wide-character boundaries

### 10.3 xterm-headless tests

Use `@xterm/headless` to validate the terminal's resulting screen and scrollback rather than only returned strings.

Required resize sequence:

```text
120x40 start
-> user message
-> streaming reasoning/tool/text
-> resize to 30x16
-> continue streaming
-> resize to 80x24
-> open and close overlay
-> interrupt
-> type again
-> exit
```

Assertions:

- no physical line exceeds terminal width
- composer borders remain one physical row
- no duplicate transcript in scrollback
- no unexplained blank bands
- user-message background does not wrap into extra rows
- cursor remains inside the composer
- committed content appears exactly once
- terminal modes are restored on exit

Additional matrix:

- widths: 20, 30, 40, 80, 120, 200
- heights: 8, 10, 16, 24, 60
- repeated resize storm
- 1,000+ transcript lines
- ASCII, Chinese, Japanese, emoji, combining marks
- 100 KB and 1 MB bracketed paste
- resize while modal is open
- resize while composer is multiline
- tool preview grow/collapse oscillation
- `/clear`, `/compact`, `/rewind`, and session switch
- SIGTERM and simulated fatal error

### 10.4 PTY tests

A real PTY harness covers:

- raw input decoding
- Ctrl+C and Escape cancellation
- modified Enter
- Kitty key press/repeat/release behavior
- bracketed paste chunking
- suspend/resume
- signal cleanup
- shell prompt placement

### 10.5 Manual terminal matrix

Before cutover:

- macOS Terminal
- iTerm2
- Kitty or WezTerm
- tmux
- SSH
- Linux terminal
- CJK IME
- Windows Terminal if retained as a supported target

## 11. Implementation plan

All work remains on `rewrite/pi-tui` until the final TUI passes the release gates. Intermediate commits should remain reviewable and buildable; they need not expose the new TUI through the production CLI.

### Phase 0 — Freeze the contract

Commit: `docs(tui): define pi-tui rewrite contract`

- land this document
- record existing shortcuts and visible behavior
- map old tests to parity rows
- capture current startup/session summary behavior
- record performance baselines for long transcript and streaming

Exit gate: no major existing feature is absent from the parity matrix.

### Phase 1 — Import and package upstream

Commits:

- `vendor(pi-tui): import upstream 0.84.2 at e5dde9a`
- `build(pi-tui): integrate vendored renderer`

Work:

- mechanically import `packages/tui`
- add `LICENSE`, `UPSTREAM.md`, and empty patch ledger
- rename package without changing renderer behavior
- run upstream tests
- establish workspace/build/package strategy
- prove `npm pack` clean install contains renderer and native assets

Exit gate: upstream tests, root build, root tests, and packaged smoke test pass.

### Phase 2 — Renderer terminal harness

Commit: `test(tui): add xterm and PTY renderer harnesses`

Work:

- FakeTerminal helpers
- xterm screen/scrollback inspection
- PTY lifecycle harness
- resize, scrollback, cursor, and terminal restoration invariants

Exit gate: harness deterministically reproduces the class of resize defects seen in the Ink TUI and passes against the unmodified pi-tui baseline where applicable.

### Phase 3 — Extract the runtime controller

Commits are organized by responsibility, not by files:

- event reducer and streaming accumulator
- queue/steer and submit lifecycle
- overlay request lifecycle
- session transition
- goal/task/loop runtime
- provider/model/slash actions

The old Ink app consumes the extracted controller during this phase so extraction can be verified without changing the renderer.

Exit gate: controller tests cover event, session, overlay, and shutdown state machines; old TUI behavior remains green.

### Phase 4 — Minimum complete vertical slice

Commit: `feat(tui): add pi-tui conversation vertical slice`

Capabilities:

- terminal start/stop
- welcome/footer
- existing transcript reconstruction
- user composer
- submit
- text/reasoning streaming
- interrupt
- second turn
- exit summary
- startup session picker

Exit gate: a real Agent session can be started, resumed, used for multiple turns, resized during streaming, interrupted, and exited cleanly.

### Phase 5 — Transcript parity

Work:

- Markdown and code highlighting
- tool lifecycle and grouping
- edit/write diffs
- compaction and interruption rows
- subagent projection
- long-conversation caching

Exit gate: all transcript/markdown/tool parity tests and resize oscillation tests pass.

### Phase 6 — Composer parity

Work:

- editor semantics
- history
- paste
- slash/skill completion
- file mentions
- image attachments
- queue/steer
- IME/hardware cursor

Exit gate: composer unit, xterm, PTY, and manual CJK tests pass.

### Phase 7 — Overlay and picker parity

Work:

- explicit overlay stack and focus
- plan/approval/question/feedback
- model/provider/key/theme/skill/command/session/rewind pickers
- stats, subagent inspector, setup flows

Exit gate: every blocking request settles under accept, reject, cancel, session switch, and shutdown.

### Phase 8 — Runtime integration parity

Work:

- Grok runtime
- goal/loop
- tasks and promotion
- MCP/LSP and memory commands
- hooks and update notices

Exit gate: integration parity matrix is green and no manager subscription/timer survives shutdown.

### Phase 9 — Soak and release gates

- full tests and build
- npm pack clean install
- long-session performance and memory
- repeated resize/overlay/tool oscillation
- manual terminal matrix
- compare exit/session persistence artifacts
- audit terminal escape writes and lifecycle restoration

Exit gate: all completion criteria in section 12 pass.

### Phase 10 — One-way cutover

Commit: `refactor(tui)!: replace Ink with pi-tui`

This commit only:

1. switches both main TUI and startup session picker imports
2. deletes `src/tui-ink/**`
3. removes Ink/React dependencies and JSX settings
4. removes or renames obsolete Ink-specific tests
5. updates documentation and release notes

It must not add new product behavior or renderer patches.

## 12. Completion criteria

The rewrite is complete only when:

- `src/tui-ink` is deleted
- production source has no imports from `ink` or `react`
- Ink/React packages are removed from production dependencies
- no user-facing old-TUI fallback exists
- both TUI startup entry points use the new application
- all parity rows are `PASS` or explicitly `NOT APPLICABLE`
- resize, scrollback, cursor, PTY, and IME gates pass
- no renderer line exceeds current terminal width, including at widths below 40
- npm tarball installs and runs in a clean directory
- native terminal helpers are present for supported platforms
- session/config formats remain backward-compatible
- orderly and fatal exits restore the terminal
- vendored pi-tui has pinned upstream metadata and MIT license
- downstream renderer patches have tests and ledger entries
- the final cutover is a single one-way switch

## 13. Rollback

The rewrite branch is isolated from `main`. Before merge, rollback means abandoning or resetting the branch; the production TUI is unaffected.

After merge, rollback is a normal Git revert of the cutover/rewrite merge, not a runtime fallback. The old Ink implementation remains recoverable in Git history but is not shipped alongside the new TUI.

Session and config compatibility is the key rollback guarantee: a user who temporarily returns to the previous Bubble release must still be able to open sessions created while using the new TUI.

## 14. First implementation checkpoint

The next checkpoint after this design is accepted is **not** a Bubble component port. It is:

1. import the exact upstream `packages/tui` subtree at the pinned SHA
2. preserve license and source metadata
3. make upstream tests pass unchanged
4. establish package/build/npm-pack behavior
5. add terminal resize and scrollback harnesses

Only after that foundation is reproducible should product UI implementation begin.
