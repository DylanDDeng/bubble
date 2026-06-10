# Lifecycle Hooks

Bubble lifecycle hooks let local scripts observe selected agent events and deny a small set of pre-flight events. Hooks are configured in the existing settings files:

- `~/.bubble/settings.json`
- `<repo>/.bubble/settings.json`
- `<repo>/.bubble/settings.local.json`

Project hooks in `<repo>/.bubble/settings.json` are loaded but do not run until trusted with `/hooks trust project`. Trust is bound to the project path, hook config fingerprint, and hashes of hook files Bubble can identify.

## Config

```json
{
  "hooks": {
    "enabled": true,
    "rules": [
      {
        "id": "deny-rm",
        "event": "PreToolUse",
        "matcher": "^Bash$",
        "command": "./.bubble/hooks/deny-rm.js",
        "timeoutMs": 3000,
        "onError": "block",
        "include": ["toolArgs"]
      }
    ]
  }
}
```

`command` is executed with `spawn` and never through a shell. Put arguments in `args`; do not write shell command strings.

## Hook I/O

Bubble sends one JSON envelope to stdin. A hook may print no output, or print JSON:

```json
{
  "decision": "deny",
  "reason": "rm -rf is not allowed"
}
```

Only these events can block: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, and `PreCompact`. Other events are observe-only; a `deny` response is logged but ignored.

A hook can expose model context only by explicitly returning it:

```json
{
  "decision": "allow",
  "visibleToModel": true,
  "modelContext": "Remember to run the repository test script."
}
```

## Management

- `/hooks status`
- `/hooks reload`
- `/hooks trust project`
- `/hooks untrust project`
- `/hooks test PreToolUse Bash`
- `/hooks explain PreToolUse`
- `/hooks logs 20`

## Events

Supported events are:

`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreModelCall`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionResult`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Notification`, `SteerInputApplied`, `QueuedInputRejected`.
