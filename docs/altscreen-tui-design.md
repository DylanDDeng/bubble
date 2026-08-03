# Alt-screen TUI mode — design note (proposal)

Status: proposal, not scheduled. Written 2026-08-03 after the Execute-row
collapse discussion. Prior art verified in source: pi's dual-renderer
architecture (`pi/packages/tui/src/tui-main-screen.ts` + `tui-alt-screen.ts`)
and Claude Code's opt-in fullscreen mode (`CLAUDE_CODE_NO_FLICKER=1` /
`/tui fullscreen`).

## Why

Three user-visible wins the current main-screen + Ink `<Static>` renderer
cannot deliver:

1. **Per-row interactivity.** Rows committed to terminal scrollback are
   immutable — that is why Execute collapse ships as a global Ctrl+O toggle,
   not click-to-expand on individual rows. An app-owned viewport can repaint
   any row on click.
2. **Zero flicker.** Alt-screen + synchronized output (CSI ?2026) lets the
   terminal composite frames atomically. This is exactly the path Claude Code
   took for its no-flicker mode.
3. **Bounded memory / redraw cost.** Only the visible window renders; a
   six-hour session paints the same number of cells as a five-minute one.

## What we give up (and the mitigations, all proven by pi)

| Loss | Mitigation |
|---|---|
| Terminal-native scrollback | App-owned `ScrollView` with wheel/trackpad/keyboard scrolling; on exit, re-print the full transcript to the main buffer so scrollback is restored post-session |
| Terminal-native text selection (mouse is captured) | Application-owned selection: track drag via SGR mouse events, paint the selection ourselves, copy via OSC 52 (`\x1b]52;c;<base64>`) — pi `tui-alt-screen.ts:665` |
| Cross-viewport selection of long output | Accept; offer "open output in pager/editor" per row as the escape hatch |
| Terminals without SGR mouse / OSC 52 | Feature-detect; degrade to keyboard-only interaction, system clipboard via pbcopy/xclip fallback |

## Shape

- **Opt-in, dual-renderer.** `uiMode: "regular" | "fullscreen"` in settings
  (mirror pi), plus `BUBBLE_FULLSCREEN=1`. `regular` (current Ink main-screen)
  stays the default until fullscreen has months of dogfooding. Both CC and pi
  ship alt-screen as opt-in; follow that caution.
- **Renderer abstraction first.** Bubble is coupled to Ink's `<Static>`
  commit model. Phase 0 is extracting a `TranscriptRenderer` interface that
  both the existing Ink path and the new fullscreen path implement, so
  components stop knowing which mode they run in. pi's `TUI` interface
  (4-method `Component`: `render(width): string[]` + `invalidate()`) is the
  reference for how small this contract can be.
- **Interactions unlocked in fullscreen:** click a collapsed Execute/tool row
  to expand in place; click a subagent row to open its inspector; hover
  scrollbar; selection + OSC 52 copy. Keyboard equivalents remain for every
  action (mouse never required).
- **Protocol pieces:** enter/leave alt screen, SGR mouse (1006), synchronized
  output (2026), OSC 52 clipboard, OSC 133 prompt marks for jump-between-turns,
  kitty image cleanup on overwrite (pi `tui-main-screen.ts:136`).

## Cost estimate

pi's tui package is ~23k LOC with the alt-screen renderer at ~800 lines plus
a 1.4k-line key/mouse parser — but pi built everything from scratch. Bubble
keeps Ink for layout and only owns the frame loop + viewport + input capture
in fullscreen mode. Rough phasing:

- P0: renderer abstraction, no behavior change (medium)
- P1: fullscreen mode with app scrolling + exit-reprint, keyboard only (large)
- P2: mouse capture, per-row expand, app-owned selection + OSC 52 (large)
- P3: polish — scrollbar, OSC 133 jumps, image handling (medium)

## Non-goals

- Replacing the regular mode. Main-screen + native scrollback remains the
  default and must stay fully supported.
- Mouse-required UX. Every interaction keeps a keyboard path.
