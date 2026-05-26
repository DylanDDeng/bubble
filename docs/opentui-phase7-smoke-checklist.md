# OpenTUI Phase 7 Smoke Checklist

Phase 7 makes the restored OpenTUI/Solid runtime the default TUI while keeping
the legacy Ink runtime available behind `BUBBLE_TUI=ink`.

## Build gates

- `npm run build`
- `./dist/bin.js --help`
- `BUBBLE_TUI=ink ./dist/bin.js --help`

`dist/main.js` is a Bun entrypoint. Use `./dist/bin.js` for the packaged CLI
path, or `bun dist/main.js` when running the main module directly.

## Default OpenTUI runtime

Run:

```sh
./dist/bin.js
```

Check:

- The app starts without setting `BUBBLE_TUI`.
- A fresh empty session opens on the centered Home surface, not directly in the transcript view.
- Typing a prompt updates the input box.
- `Shift+Enter` inserts a newline.
- `Enter` submits the prompt.
- After the first submitted prompt, the UI switches into the session surface with the transcript, top status line, bottom composer, and footer.
- `Ctrl+C` exits cleanly and returns the terminal to normal input.
- Resizing the terminal keeps the layout usable.
- `/model`, `/provider`, `/skills`, `/theme`, `/clear`, and `/quit` still open or execute.
- A command that requests approval shows the approval prompt.
- A question-tool request shows the question prompt.
- `--resume` with no `--session` opens the OpenTUI session picker.

## Ink fallback

Run:

```sh
BUBBLE_TUI=ink ./dist/bin.js
```

Check:

- The legacy Ink UI starts.
- `--resume` with no `--session` opens the Ink session picker.
- `/quit` exits cleanly.

## Lockfile and migration cleanup

Check:

- `package-lock.json` includes `@opentui/core`, `@opentui/solid`, and `solid-js`.
- `@opentui/react` is still present only for the temporary React/OpenTUI comparison path.
- There is no committed `bun.lock` in this npm-managed package.
- The one-shot `scripts/convert-ink-jsx.ts` migration helper is not present.

## Known follow-up areas

The default runtime is the restored OpenTUI/Solid implementation. The React
OpenTUI directory is kept as a temporary comparison path while missing recent
features are backfilled into the restored runtime.
