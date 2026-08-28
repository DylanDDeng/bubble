# Vendored pi-tui — upstream provenance

This directory is a Bubble-maintained fork of the pi-tui terminal UI
framework. It is vendored into this repository (not installed from npm) so
Bubble can fix renderer-level defects directly, the same maintenance model
used by Kimi Code.

- Repository: https://github.com/earendil-works/pi
- Subtree: packages/tui
- Tag/version: 0.84.2
- Commit: e5dde9a76bfec3c4eff764d1b6db3b60e5dd0b30
- Imported at: 2026-08-18
- License: MIT (see LICENSE — Copyright (c) 2025 Mario Zechner)
- Local package: @bubblebrain-ai/pi-tui (private)

## Import notes

- The subtree was imported mechanically; no Bubble source changes were made
  at import time beyond `package.json` identity fields (`name`, `private`,
  `description`, `test` script flags, `repository` pointer to the upstream
  repo/subtree).
- The package declares `engines.node >= 22.19.0`, matching the root Bubble
  requirement.
- Upstream tests run under `node --test` with type stripping; they use
  `@xterm/headless` and a local `VirtualTerminal`.

## Upstream sync procedure

1. Never re-vendor ad hoc. Syncs are deliberate, separate commits:
   `vendor(pi-tui): sync upstream packages/tui at <sha>`.
2. Reapply Bubble renderer patches afterwards as individual commits, each
   mirrored in DOWNSTREAM_PATCHES.md.
3. No upstream sync during the parity-critical final cutover window.
4. After every sync: run this package's tests, then Bubble's terminal gates.
