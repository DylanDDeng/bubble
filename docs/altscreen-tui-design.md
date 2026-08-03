# Alt-screen TUI mode — design note (proposal, rev 2)

Status: proposal, not scheduled. **P1+ is gated on the Phase-0 spike below.**

Revision log:
- rev 1 (2026-08-03): initial draft after the Execute-collapse discussion.
- rev 2 (2026-08-03): reworked after a 4-lens panel review + judge pass
  (verdict: rework). All 13 confirmed findings incorporated; the two
  load-bearing corrections were re-verified by hand against sources
  (`node_modules/ink/build/ink.js:83,331`; pi `tui-main-screen.ts:178-200`).
  Key changes: "keep Ink for layout" demoted from premise to open question,
  win #2/#3 removed from the alt-screen pitch (flicker is fixable in
  main-screen mode; paint — not render — is what alt-screen bounds), and
  lifecycle/clipboard/hit-testing sections added.

Prior art: pi's dual-renderer TUI (verify against pi-mono **origin/main**;
older checkouts predate the alt-screen split) and Claude Code's fullscreen
mode (`CLAUDE_CODE_NO_FLICKER=1` / `/tui fullscreen` — reported behavior,
not source-verifiable; CC ships minified).

## Why

The one thing this mode uniquely buys is **per-row mouse interactivity**:
click a collapsed Execute/tool row to expand it in place, click a subagent
row to open its inspector, drag to select with app-owned selection. Rows
committed to terminal scrollback are immutable, so no main-screen design can
do this.

The other two wins claimed in rev 1 do NOT require alt screen and are
severable regular-mode work, schedulable independently today:

- **Flicker**: wrap main-screen paints in synchronized output (CSI ?2026),
  exactly what pi's MAIN-screen renderer does (`tui-main-screen.ts:178-200`).
- **Turn navigation**: OSC 133 prompt marks work in native scrollback;
  in alt screen they would have to be app-implemented anyway (pi strips the
  marks from output and scans its own document lines).

Rev 1's "bounded memory / same paint at hour six" claim was wrong: pi renders
and retains the FULL document every frame (`scroll-view.ts` renders the whole
child; exit-reprint and selection need all lines); only the *paint* is
diffed and viewport-bounded. Losing Ink's `<Static>` makes every streaming
flush an O(transcript) React render — the exact cost our own comments call
prohibitive (`src/tui-ink/app.tsx` Static rationale, `message-list.tsx`
memo notes). Any fullscreen design must add a per-row rendered-line cache
with explicit invalidation to compensate, and owns an O(session) line-buffer
memory story.

## Phase 0 spike (1-2 days, decides everything)

Rev 1 assumed "Bubble keeps Ink for layout and only owns the frame loop +
viewport + input capture". That is not implementable as written: Ink 7.0.3
has an `alternateScreen` option but **no viewport, scroll, or mouse API**,
and any frame taller than the terminal triggers clear-terminal plus a replay
of the entire accumulated `<Static>` output per render
(`ink.js:83 shouldClearTerminalForFrame`, `:331 fullStaticOutput + output`)
— the worst-flicker path. Two viable strategies; the spike picks one:

- **(a) Captured-tree**: mount the existing App against a fake-TTY stream,
  Ink renders the whole tree into a buffer, the app slices and paints the
  visible window. Keeps React components as-is; pays O(transcript) layout
  per frame; needs row markers for hit-testing (below).
- **(b) Per-row render-to-string + app compositor** (pi's model,
  `tui.ts` 4-method Component). Bounded per-frame cost via a row cache, and
  hit-testing falls out of row geometry — but one-shot renders break our
  stateful row components (async shiki highlight upgrade, `useDeferredValue`
  streaming, `DynamicClamp` measureElement), which would need their state
  moved into the row-cache pipeline.

Spike deliverables: prototype both against a 2k-row transcript, measure
frame cost, pick, and rewrite Shape/Cost below around the choice.

## Shape

- **Opt-in, dual-renderer.** `uiMode: "regular" | "fullscreen"` in settings
  plus `BUBBLE_FULLSCREEN=1`, and a `/fullscreen` toggle (document whether it
  is live or restart-required; pi's is restart-required). `regular` stays the
  default. Graduation to default requires explicit criteria (crash-free
  sessions, opt-in retention, no unresolved terminal-compat issues) — and the
  steady-state cost is real either way: every interactive component works
  under both modes indefinitely.
- **TranscriptRenderer interface, specified at the operation level the ~20
  existing imperative call sites need**: `appendRows`, `rebuildAll`
  (non-monotonic: /clear, rewind, session switch), `invalidateAll`
  (verbose/theme toggle), `onResize` policy, streaming-region update, exit
  snapshot. Regular mode implements some ops destructively (wipe + reprint);
  fullscreen implements them cheaply. P0 splits accordingly:
  - **P0a (medium)**: funnel every imperative site (raw `\x1b[2J\x1b[3J`
    reprints, Ctrl+O wipe, debounced resize reflow, per-terminal commit
    strategy, exit-frame choreography) through one facade. No behavior change.
  - **P0b (large)**: make MessageList mode-agnostic per the spike's strategy.
- **Hit-testing (required before P2 is credible)**: map viewport (x,y) →
  transcript row. Strategy (a): zero-width APC row markers injected per row
  and stripped at paint time (pi's CURSOR_MARKER pattern) building a
  lineIndex→messageKey map; strategy (b): row-cache geometry directly. Also
  translate cursor/IME position buffer→viewport (suppressed when the composer
  scrolls off-screen) — CJK IME correctness is an existing requirement.
- **ANSI state at window boundaries (P1)**: painting a mid-document window
  must re-establish SGR state at the first visible line. Cached document
  lines are self-contained and reset-terminated (pi's approach; its slicing
  runs through ~1.3k lines of ANSI-aware utils). Our `width.ts` measures
  only — it cannot slice styled lines; that machinery is new work.
- **Interactions**: click-to-expand rows, subagent inspector, scrollbar,
  selection + copy. Keyboard equivalents remain for every action.
- **Find-in-transcript (P1)**: alt screen loses terminal-native scrollback
  search (Cmd+F); ship in-app search (highlight + n/N) or list search as an
  explicit accepted loss.

## Terminal lifecycle (P1, non-negotiable)

Absent from rev 1; pi treats all three as mandatory:

- **Restore**: one idempotent restore sequence — end synchronized output
  (?2026l) first, all mouse modes off, autowrap on (?7h), cursor visible
  (?25h), leave alt screen (?1049l), pop kitty keyboard flags — written from
  orderly exit AND uncaughtException/SIGTERM/SIGHUP, bypassing the renderer.
  Our current `restoreTerminal` writes cursor-show only and assumes no
  alt-screen/mouse state exists.
- **Suspend/resume**: SIGTSTP = full teardown + restore before stopping;
  SIGCONT = re-enter from reset state + synthetic resize (SIGWINCH during
  stop is lost). pi adds a keep-alive interval and process-group signaling.
- **Resize**: full repaint + scroll-anchor policy + selection invalidation;
  width change invalidates every cached line.

## Clipboard (degraded, not "mitigated")

Rev 1's "app-owned selection + OSC 52, all proven by pi" oversold it: pi's
alt-screen copy is an unconditional OSC 52 write with a "Copied!" toast — no
detection, no cap, no fallback — while pi's own `clipboard.ts` prefers
platform tools and documents that large OSC 52 payloads desync rendering.
OSC 52 success is not queryable, and common defaults (iTerm2 preference,
tmux `set-clipboard`) silently drop it. Order for Bubble: platform tool
first (pbcopy/wl-copy/xclip, exit-code-verified), OSC 52 only for SSH —
chunked, size-capped, best-effort toast, `$TMUX` passthrough wrapping.
Oversized selections route to the per-row "open in pager" escape hatch.

## Protocol pieces (full set)

Mouse is not one mode: pi enables 1000h+1002h+1003h+1004h+1006h together,
parses BOTH SGR and legacy `\x1b[M` encodings (no capability detection
exists), cancels in-flight selection on FOCUS_OUT, disables autowrap and
hides the cursor on entry. Kitty keyboard flags must be pushed/popped inside
the alt screen — kitty keeps separate mode stacks per screen buffer, so a
runtime toggle re-pushes around every 1049 transition. P2 must subsume
`src/tui-ink/terminal-mouse.ts` (today: 1000h+1006h, opt-in) so exactly one
parser owns stdin, with cross-chunk escape-sequence reassembly (pi needs a
434-line stdin buffer for this). Keep the CSI 6n width probe working, and
decide the degraded-mode wheel policy (?1007 alternate-scroll when mouse
capture is off).

Exit-reprint (restoring "scrollback" after the session) has fidelity limits
pi accepts and we should state: lines hard-truncated to exit-time width,
images dropped, orderly-exit only — the session file remains the crash
recovery path. The reprint also requires the full transcript-to-string path,
i.e. the row cache again. Images in fullscreen: kitty only
(delete-on-overwrite); iTerm2 inline images are disabled for the whole
alt-screen session (pi sets `images: null` on entry) and degrade to
placeholders.

## Cost (corrected)

pi's tui package is ~14.4k LOC source (~29k with tests). The alt-screen
renderer file is ~880 lines, but its real dependency delta is **~4k+ lines**:
base TUI/frame loop (~1.2k), ANSI slicing utils (~1.3k), terminal layer
(~530), stdin buffering (~430), layout/scroll-view (~600). Bubble reuses
none of that today.

- P0 spike: rendering strategy decision (small, gates everything)
- P0a: renderer facade over existing imperative sites (medium)
- P0b: mode-agnostic MessageList per chosen strategy (large)
- P1: fullscreen mode — viewport, row cache, lifecycle, ANSI window state,
  find-in-transcript, keyboard-only (large)
- P2: mouse capture, hit-testing, per-row expand, selection + clipboard
  (large)
- P3: scrollbar polish, app-implemented turn jumps, kitty images (medium)

## Alternatives considered

- **Keyboard row-expand in regular mode**: a per-row expanded flag + the
  existing wipe-and-reprint path (what Ctrl+O uses) gives select-a-row-and-
  expand without any renderer work. Cheapest next step if per-row disclosure
  is the only demand.
- **Desktop GUI**: already has real mouse interactivity for mouse-first users.
- **HTML session export**: deep post-hoc inspection without terminal limits.

Go/no-go for P1+: schedule only if regular-mode disclosure (Execute collapse
+ Ctrl+O, keyboard row-expand if built) demonstrably fails users — otherwise
this stays a proposal.

## Non-goals

- Replacing regular mode; main-screen + native scrollback stays the default
  and fully supported.
- Mouse-required UX; every interaction keeps a keyboard path.
