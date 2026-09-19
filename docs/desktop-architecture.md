# Bubble Desktop

Bubble is a standalone agent. The desktop uses Aegis's MIT-licensed React/Electron workspace and adapts it to the local Bubble SDK; it is not a launcher for Claude Code, Codex CLI, or other agent runtimes. Desktop development is the primary UI direction; the existing CLI remains available.

## Start from this checkout

```sh
npm install
npm run desktop:install
npm run dev
```

`npm run dev` (alias: `npm run desktop:dev`) starts the Vite development server and Electron. It initially compiles the local SDK and Electron host; it does not run `vite build` or package an application. UI edits use Vite/React hot updates. Electron, preload, shared protocol and SDK source edits trigger a debounced compile and Electron restart. A compile error leaves the running app in place; saving a fix retries. Backend restarts end active runs, so use development sessions for this workflow.

The supervisor owns the Vite server, source watchers and child processes. Ctrl+C or quitting Electron stops them together. The default address is `http://127.0.0.1:4327`; set `PORT` to change it. An occupied port fails explicitly rather than attaching to another app. `npm run desktop:qa` creates a separate temporary desktop and Agent profile for verification. `BUBBLE_DESKTOP_ELECTRON` optionally selects a test Electron executable.

Use `npm run dev:tui` for terminal development. `npm run desktop` compiles a renderer build and starts Electron without hot updates. `npm --prefix desktop start` launches the last compiled desktop; `npm run desktop:build` checks a full build without launching.

Development SDK compilation uses `desktop/.dev-sdk-build` before syncing into `desktop/runtime/bubble`; it does not clear the CLI's `dist` output.

Node 22.19 or newer is required. The desktop has its own dependency installation and Electron-native SQLite/PTY builds. It does not replace the CLI's native modules. On macOS the install helper uses `/usr/bin/python3` unless `PYTHON` is explicitly set. A local macOS dogfood package is available with `npm run desktop:package`. Developer ID signing, notarization, automatic updates and release publication remain deferred.

## Implementation

```text
React workspace (desktop/src/ui)
    ↓ Electron contextBridge / typed IPC
Electron main (desktop/src/electron)
    ↓ BubbleSdkAdapter
Local SDK snapshot (desktop/runtime/bubble/dist)
    ↓
This repository's Bubble agent, tools, providers, skills and sessions
```

- `scripts/sync-bubble-sdk.mjs` copies the repository's compiled SDK into the desktop runtime; dependencies resolve against the Electron installation.
- `libs/provider/bubble-sdk-adapter.ts` maps streaming text, reasoning, tool execution, approvals, questions, plans, stop and subagent progress into the desktop event model.
- `libs/agent-loop.ts` registers only Bubble and rejects other agent runtimes.
- Skills use the SDK's actual discovery paths and read the full registered `SKILL.md`. The skill library has no agent tabs.
- The model picker selects Bubble model providers/models and reasoning levels. API model vendors remain available; they are distinct from separate agent applications.
- KanBan retains Aegis's board, task details, stages and session links. Imported history starts in Review, preserving original dates without claiming completion. Subsequent board placement belongs to the user.
- Automations persist in the desktop database, schedule Bubble sessions and retain run history. They run while the desktop host is running. As indicated in the form, scheduled runs automatically approve runtime prompts.
- Pull Requests retain the repository/GitHub integration; remote access depends on the user's GitHub CLI authentication and repository permissions.
- MCP and Providers manage Bubble configuration. Usage shows recorded desktop turns; imported conversations without usage metadata are excluded. The upstream Claude/Codex Bridge is not exposed.
- Some upstream compatibility modules and types remain internally during migration; they are not registered as agent runtimes or selectable in the UI.

## Data and appearance

Data profiles are configured by `data-environment.ts` before any store or SDK imports. `npm run dev` selects `Bubble Dev` under Electron's appData directory and `~/.bubble-dev` for Agent data. `npm run desktop` and `npm --prefix desktop start` select the existing production `Bubble` and `~/.bubble` directories. `npm run desktop:qa` generates a fresh `bubble-desktop-qa-*` temporary root, with separate `desktop/` and `agent/` children. The QA root survives hot restarts but is never reused by the next QA launch. It is retained for diagnostics after exit.

Launchers clear inherited profile/path overrides before selecting their mode. A direct unpackaged Electron launch defaults to dev; the production start command selects production explicitly. Direct Electron test launches can explicitly use `BUBBLE_DESKTOP_PROFILE=qa` with `BUBBLE_DESKTOP_QA_ROOT`; legacy standalone `BUBBLE_DESKTOP_USER_DATA` / `AEGIS_USER_DATA_DIR` overrides are treated as QA and derive an isolated Agent home below the override. Non-production paths cannot overlap the managed production paths; QA cannot overlap the developer's paths, including symlink aliases. Directory errors stop startup instead of falling back to production. `BUBBLE_HOME` is set before SDK import, and the desktop MCP/model helpers resolve the same home. No profiles copy credentials or migrate production data automatically. Project files and deliberately selected project-level configuration remain shared by project path; data profiles are not filesystem sandboxes.

The first launch imports only the selected profile's Bubble SDK history into its desktop SQLite presentation store. The import is transactional per session and idempotent; original JSONL files are unchanged. A profile-local marker prevents repeatedly restoring conversations the user later removes in the desktop. New and resumed execution remains owned by the SDK. Existing mixed legacy sessions remain in the production profile; they are not silently deleted or copied into dev/QA.

The installed Aegis app was inspected as the visual reference: purple Arc theme, wallpaper, 250 px sidebar, tabs, composer, workstream, settings and feature views. `appearance-reference.json` and `build/skins/aegis-reference.png` seed a fresh profile only; existing appearance choices are preserved. Accounts, credentials, sessions and automations are not copied from Aegis.

## Provenance and validation

The UI/backend baseline comes from the local `coworker` source under MIT. See `desktop/LICENSE` and `desktop/THIRD_PARTY_NOTICES.md`. No extracted proprietary Codex code is shipped. The former desktop implementation is preserved under `desktop/legacy` for reference and is not the active entrypoint.

```sh
npm run desktop:build
npm run desktop:test
```

The test command covers workstream grouping/order/duration, board semantics/history placement, composer selection, session history, subagent event shapes and adapter wiring. A headless Electron integration test uses the real local SDK/native SQLite and a localhost model fixture to exercise streaming, approval, shell execution, persistence, skill detail, idempotent import and automation routing without sending data to an external model.

Native desktop QA covers appearance, model/reasoning selection, Bubble skills and full document details, MCP, Providers, Usage, automations, KanBan, PR navigation and workstream disclosure. Build/test success does not imply a packaged release or pixel comparison of every possible screen/state.

### Subscription authentication

The desktop reuses Bubble's OpenAI and Grok OAuth implementations in a disposable Electron utility process. Cancelling sign-in, closing its window or quitting terminates that process and releases its callback listener. The main process saves successful credentials through the SDK registry's `AuthStorage` in the selected `BUBBLE_HOME`; the renderer receives only login status. OpenAI keeps a separate API key editor, while Grok Subscription rejects API-key configuration. Logout removes legacy OpenAI credential aliases as well. Model caches are matched to the authentication identity so an API catalog cannot be reused for a subscription account.

`npm --prefix desktop run verify:bubble-oauth` runs the real SDK PKCE and loopback callbacks under Electron with a fake remote token response and disabled browser launch. It checks both providers, isolated storage, token redaction, logout aliases, enable/default settings, cancellation/socket cleanup, retry, removal, catalog separation and safe errors. It does not authenticate a real account or prove subscription entitlement with a live model request.

## Local dogfood package

Run `npm run desktop:package` at the repository root on macOS. It builds the current SDK and desktop, prepares Electron native dependencies, and creates `desktop/out/dogfood/mac-arm64/Bubble.app` (Apple Silicon) and `desktop/out/dogfood/Bubble-0.1.0-arm64-dogfood.dmg`. The Intel app directory is `mac` and the artifact uses `x64`. Packaging always passes `--publish never` and has no update feed.

The app contains the Bubble SDK and its runtime dependencies; users do not need a global Bubble CLI installation. The initial setup opens Providers to configure a model account. Normal packaged launches use `~/Library/Application Support/Bubble` and `~/.bubble`, independently of dev and QA profiles. Updating the `.app` preserves those data directories; source edits appear in an installed build only after rebuilding and replacing it.

The local app is ad-hoc signed, not Developer ID signed or Apple-notarized. This is for local dogfooding, not public distribution. The packaging command checks the signature and runs the bundled SDK outside the checkout, using a local fake provider and temporary data to verify approvals, tool execution, persistence, skills, and automation routing. It does not authenticate a live subscription or certify long-running stability.
