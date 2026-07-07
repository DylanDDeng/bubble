# Bubble × Terminal-Bench (Harbor adapter)

Harbor agent adapter that runs Bubble on [Terminal-Bench 2.1](https://www.tbench.ai/).
Designed to run on an **x86_64 Linux server** (arm64 Macs emulate amd64 task
images and add noise; keep official numbers on x86).

## How it works

- `install-bubble.sh.j2` runs inside each task container: installs Node 22
  (nvm), Bun (bubble's launcher requires it), then
  `npm i -g @bubblebrain-ai/bubble`.
- `BubbleAgent.create_run_agent_commands` writes `~/.bubble/models.json`
  (Bubble reads API keys from there, not from env vars), then runs
  `bubble -p --dangerously-skip-permissions -m <model> "<instruction>"`.
- Model is passed in Harbor's `provider/model` form, e.g.
  `anthropic/claude-sonnet-4-5`, `deepseek/deepseek-chat`,
  `gemini/gemini-2.5-pro`. The provider segment is mapped to Bubble's
  builtin provider ids (see `PROVIDER_ID_MAP`).

## Server setup (Ubuntu, once)

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# uv + harbor
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install harbor

# this adapter
git clone <this-repo> && cd my-coding-agent/bench/terminal-bench
uv venv && source .venv/bin/activate
uv pip install -e .

# API key for whichever provider you benchmark
export ANTHROPIC_API_KEY=sk-ant-...
```

## Running

```bash
# 1. Environment sanity check — oracle solutions, costs no API money
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5

# 2. Smoke test — 5 tasks through Bubble
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path bubble_terminal_bench:BubbleAgent \
  -m anthropic/claude-sonnet-4-5 \
  -l 5 -n 2

# 3. Fixed regression subset (day-to-day; pick ~10 tasks and pin them)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path bubble_terminal_bench:BubbleAgent \
  -m anthropic/claude-sonnet-4-5 \
  --include-task-name <task-a> --include-task-name <task-b> ... \
  -n 4

# 4. Full official run (leaderboard-style: 5 attempts per task)
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path bubble_terminal_bench:BubbleAgent \
  -m anthropic/claude-sonnet-4-5 \
  -k 5 -n 4
```

Pin the Bubble version for reproducible runs:

```bash
harbor run ... --agent-kwarg version=0.0.34
```

## Notes / known issues

- **Untested first run**: this adapter is written against Harbor's
  `BaseInstalledAgent` API as of 2026-07 (mirrors the pi-terminal-bench
  adapter). Expect to iterate on the first smoke run — check
  `bubble-output.txt` in the trial's agent logs dir when a task fails.
- **Token/cost accounting is not populated**: `bubble -p` prints plain text
  and has no structured trajectory output yet. If we want cost columns in
  results, Bubble needs a `--output json` (or session-log parse) first.
- **docker cp nesting bug**: the pi adapter README reports that some Harbor
  versions nest uploads (`/tests/tests/test.sh`). If oracle runs fail with
  missing test files, check whether your Harbor version needs the
  `upload_dir` patch.
- Keys for other providers: `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`,
  `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `ZHIPUAI_API_KEY`, or generic
  `BUBBLE_API_KEY` override (see `API_KEY_ENV_MAP`).
