# Downstream patches to vendored pi-tui

Every Bubble change to files under `packages/pi-tui/src` or
`packages/pi-tui/native` must have an entry here (identity/`package.json`
metadata changes from the initial import are exempt).

| ID | Commit | Files | Reason | Regression test | Upstreamable | Replay risk |
|----|--------|-------|--------|-----------------|--------------|-------------|
| — | — | — | No downstream source patches yet. | — | — | — |

Entry fields:

- **Reason**: the production symptom or capability gap that motivated the
  patch, not just the mechanism.
- **Regression test**: a test under `packages/pi-tui/test/` that fails
  without the patch (renderer bug fixes must come with a terminal-level
  reproduction).
- **Upstreamable**: whether the patch has been / will be submitted upstream;
  upstreamable patches keep future syncs cheap.
- **Replay risk**: how likely the patch conflicts on the next upstream sync.
