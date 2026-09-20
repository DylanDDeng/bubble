# Local Bubble desktop packages

Run `npm run desktop:package` from the repository root. This builds the core
SDK, builds the desktop, and creates the host-architecture macOS app and DMG
under `desktop/out/dogfood`. It does not publish or replace `/Applications/Bubble.app`.

## Runtime dependency boundary

`dependencies` contains the Bubble SDK's runtime dependencies plus Electron
main-process dependencies (SQLite, PTY, MCP, updater, etc.). TypeScript is a
runtime dependency because the bundled LSP needs its compiler and standard
library declarations.

Renderer libraries belong in `devDependencies`: Vite already bundles them into
`dist-react`. Compatibility SDKs for the inherited Aegis adapters are also
development-only; Bubble registers its own adapter and must not load those
agents for background naming or title generation. Development-only packages
remain available for compiling the compatibility source, but are absent from
the shipped app. Keep `package-lock.json` in sync with dependency moves.

The builder filters foreign SQLite, PTY and TUI native binaries and build
sources. Do not blanket-remove `.d.ts`, WASM, native spawn helpers or language
servers: some are runtime inputs. `onNodeModuleFile` preserves TypeScript's
standard libraries despite electron-builder's default declaration exclusion.

## Package validation

Packaging automatically runs:

- Content audit: no other agent SDKs, only target native binaries, required
  runtime assets present, and an installed-app size budget of 650 MB. Sizes
  are reported in decimal bytes in `out/dogfood/package-size-report.json`.
- Ad-hoc signature verification and an actual packaged-executable UI/IPC smoke
  check with isolated Electron and Agent stores.
- Packaged PTY, QuickJS/WASM and TypeScript-library checks.
- A real bundled SDK loop against a local model fixture, including tool
  approval/execution, persisted history, LSP diagnostics and subagent lifecycle.

The package is copied outside the checkout for runtime checks so missing
dependencies cannot be satisfied by development `node_modules`. Tests use
temporary data and do not use real accounts. These checks do not constitute
notarization or a public release.
