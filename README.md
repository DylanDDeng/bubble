# Bubble

Bubble is a terminal coding agent. It works inside a local project folder: it reads and edits files, runs commands behind configurable approval controls, searches and navigates code with language-server intelligence, browses the web, loads reusable skills, connects MCP tools, fans work out to subagents, and keeps persistent memory across sessions.

It is provider-agnostic. Bring an API key for OpenAI, Anthropic, Google, DeepSeek, Moonshot/Kimi, Zhipu, Z.AI, MiniMax, Groq, Together, Fireworks, a local OpenAI-compatible endpoint, and more — or sign in to ChatGPT with OAuth and drive the Codex models directly.

---

## Requirements

- Node.js 20 or newer (used to install the launcher)
- [Bun](https://bun.sh) (used to run the agent)

Install Bun if you do not already have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

The `npm install` step puts a small Node.js launcher named `bubble` on your PATH. When you run `bubble`, the launcher locates Bun and starts the real runtime under it. If Bun is missing, it prints the install command above instead of failing with a low-level error.

## Install

```bash
npm install -g @bubblebrain-ai/bubble
```

To install from a local tarball:

```bash
npm install -g ./bubblebrain-ai-bubble-<version>.tgz
```

## Quick start

Start Bubble in the current directory:

```bash
bubble
```

On first launch, connect a model:

- Run `/login` to sign in to ChatGPT (OAuth) and use the Codex models, or
- Run `/provider` to add any other provider with an API key.

Then just type what you want done. Bubble plans, edits files, and runs commands, asking for approval where the current permission mode requires it.

Point Bubble at a different project:

```bash
bubble --cwd /path/to/project
```

Resume your last conversation:

```bash
bubble --resume
```

## Model providers

Bubble ships with a catalog of built-in providers. Configure them inside the app — no environment variables required.

| How | What it does |
| --- | --- |
| `/login` | OAuth sign-in for ChatGPT; unlocks the OpenAI Codex models without an API key. |
| `/provider` | Open a picker to connect, switch, add, or remove a provider. |
| `/key <provider> <key>` | Set the API key for a provider. |
| `/model` | Pick the active model and reasoning effort. |

Built-in providers include OpenAI, Anthropic, Google, DeepSeek, Moonshot (CN and international), Kimi for Coding, Zhipu AI, Z.AI, Alibaba DashScope, Doubao (Volcengine Ark), MiniMax, StepFun, Groq, Together AI, Fireworks, and a `local` profile for any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, etc.).

For Doubao Seed models on Volcengine Ark, run `/provider --add doubao` and paste your Ark API key. The built-in endpoint is `https://ark.cn-beijing.volces.com/api/v3` and uses Ark's Responses API. The model picker exposes `minimal`, `low`, `medium`, and `high`, defaulting to `high`; `minimal` disables Ark thinking, while the other levels enable it.

### Custom providers and models

For full control — custom base URLs, self-hosted gateways, extra models, or pinning a protocol — define providers in `~/.bubble/models.json`:

```json
{
  "providers": {
    "my-gateway": {
      "baseURL": "https://gateway.internal/v1",
      "apiKey": "sk-...",
      "protocol": "openai-chat",
      "models": [
        { "id": "my-model", "name": "My Model" }
      ]
    }
  }
}
```

`protocol` accepts `openai-chat` (default), `anthropic-messages`, or `ark-responses`. Entries in `models.json` take precedence over the built-in catalog.

### Reasoning effort

Models that support it expose a reasoning-effort control: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Set it with `/model <id> --reasoning-effort <level>` in the app, or at launch with `--reasoning` (medium) or `--reasoning-effort <level>`.

## Permission modes

Bubble gates risky actions behind a permission mode. Press `Tab` to cycle modes during a session, or set a default with `--plan` / `--dangerously-skip-permissions` / project settings.

| Mode | Behavior |
| --- | --- |
| Default (Build) | File edits and writes auto-approve; bash and other tools prompt unless covered by an allow rule. |
| Plan | Read-only investigation. The agent proposes a plan and waits for your approval before making changes. |
| Bypass | Auto-approves every tool and disables all safety prompts. Enable deliberately with `--dangerously-skip-permissions`. |

Allow/deny rules are configured per scope and persisted across sessions. Manage them in-app with `/permissions`, or edit the settings files directly:

- `~/.bubble/settings.json` — user scope (applies everywhere)
- `<project>/.bubble/settings.json` — project scope (commit to share with your team)
- `<project>/.bubble/settings.local.json` — local overrides (gitignore)

Rules use a simple pattern syntax, for example:

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Bash(git status)",
      "Bash(npm run:*)",
      "Read(./src/**)",
      "WebFetch(domain:github.com)"
    ],
    "deny": ["Read(~/.ssh/**)"]
  }
}
```

## What Bubble can do

**Files and code.** Read, write, and make targeted edits; find files by glob; search contents with ripgrep; and navigate with language-server operations (go-to-definition, find references, hover, document/workspace symbols, call hierarchy).

**Shell and dev servers.** Run bounded bash commands with streaming output, and start/stop/inspect long-running dev servers (`npm run dev`, Vite, Next, etc.) with readiness checks and captured logs.

**Web.** Search the web and fetch/extract page contents on demand.

**Skills.** Drop reusable instructions and assets into a `SKILL.md`-based directory and invoke them with `/<skill-name>`. Bubble discovers skills from `~/.bubble/skills`, `~/.agents/skills`, `~/.claude/skills`, and the project's `.bubble/skills`. Browse them with `/skills`.

**MCP tools.** Connect Model Context Protocol servers (stdio, HTTP, or SSE) under the `mcpServers` key of any settings file. Their tools and prompts become available to the agent; manage connections with `/mcp`.

**Subagents.** Bubble can spawn background subagents with independent context, send them follow-ups, wait on their results, and fan a task out across a team — with concurrency limits and token budgets. Define custom agent profiles in `~/.bubble/agents` or a project's `.bubble/agents`.

**Persistent memory.** A background pipeline distills durable facts, preferences, and decisions from past sessions and recalls them later. Inspect and maintain it with `/memory status`, `/memory search <query>`, and `/memory refresh`.

**Sessions.** Every conversation is saved. Resume the latest with `bubble --resume`, or browse and switch sessions in-app with `/session`. Use `/rewind` to roll the conversation — and optionally your file edits — back to an earlier point.

## Useful slash commands

| Command | Description |
| --- | --- |
| `/help` | List available commands. |
| `/model` | Switch model and reasoning effort. |
| `/provider`, `/login`, `/logout`, `/key` | Connect and manage providers. |
| `/session`, `/rewind`, `/clear` | Manage conversation history. |
| `/skills` | Open the searchable skills picker. |
| `/mcp` | List or reconnect MCP servers. |
| `/memory` | Inspect and maintain persistent memory. |
| `/permissions` | View or edit allow/deny rules. |
| `/context`, `/stats`, `/compact` | Inspect context usage, model stats, and compact the session. |
| `/lsp`, `/hooks` | Manage language servers and lifecycle hooks. |
| `/theme`, `/sidebar` | Adjust the interface. |
| `/feedback` | Send feedback or report a bug. |

## Non-interactive mode

Run a single prompt and print the result — useful for scripts and pipelines:

```bash
bubble --print "summarize what this repo does"
echo "fix the failing test" | bubble --print
```

Combine with `--model`, `--cwd`, and `--plan` as needed.

## CLI reference

```text
Usage:
  bubble [options] [prompt]              Start interactive TUI
  bubble update [--check]                Update to the latest version (alias: upgrade)
  bubble serve --feishu [options]        Run as a Feishu bot host

Options (default):
  -m, --model <model>      Model to use
  --cwd <dir>              Working directory (default: current)
  -k, --api-key <key>      API key for the active provider
  -r, --resume             Resume a previous session (latest by default)
  --session <name>         Session name to create or resume
  --reasoning              Enable reasoning mode at medium effort
  --reasoning-effort <l>   Set reasoning effort: off|minimal|low|medium|high|xhigh|max
  --plan                   Start in plan mode (read-only investigation; propose before executing)
  --dangerously-skip-permissions
                           Enable bypass mode (auto-approve EVERY tool; disables all safety prompts)
  -p, --print              Non-interactive mode (single prompt)
  -v, --version            Print the installed version and exit
  -h, --help               Show this help
```

Run `bubble update` at any time to upgrade to the latest published version.

## Configuration and storage

Bubble keeps everything under `~/.bubble`:

```text
~/.bubble/
  config.json          User preferences (theme, default model, recent models)
  models.json          Custom providers and models
  auth.json            OAuth credentials (file mode 0600)
  settings.json        User-scope permissions, MCP servers, hooks
  sessions/            Saved conversations, grouped by project directory
  memories/            Persistent memory store
  skills/              User skills
  agents/              Custom subagent profiles
```

Environment variables:

- `BUBBLE_HOME` — override the data directory (defaults to `~/.bubble`).
- `BUBBLE_DEV=1` — use `~/.bubble-dev` instead, for development.

### Network configuration

ChatGPT OAuth and GPT/Codex requests respect the standard proxy variables:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
export HTTP_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1
```

If your network uses a corporate or custom HTTPS CA:

```bash
NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem bubble
```

`BUBBLE_EXTRA_CA_CERTS` applies the same trust to Bubble's ChatGPT requests specifically. Do not disable TLS verification with `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Development

```bash
bun install        # install dependencies
npm run build      # compile TypeScript to dist/
npm test           # run the test suite (vitest)
npm start          # run the built agent
```

`npm run dev` compiles and launches in one step. The interactive TUI is built on React Ink.

## Feishu host (optional)

Bubble can also run as a Feishu (Lark) bot host:

```bash
bubble serve --feishu --setup
```

`--setup` runs the binding wizard, `--kill-old` replaces a conflicting instance for the same App ID, and `--dry-run` connects once and exits as a smoke test.
