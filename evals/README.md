# Comparative evals

In-repo A/B verification for agent changes: real Bubble sessions (BubbleSdk →
real tools, real provider, real session files) over 15 small, objectively
scored coding tasks. Methodology follows pi / vitest-evals: **scores are
observations for a comparison table, not CI gates** — LLM output has variance,
so a pass rate is data to read, not an assertion to fail the build on.

## Run

Uses your configured providers from `~/.bubble/config.json`. Spends real
tokens — a full 15-task single-config run on deepseek-v4-flash costs on the
order of a few cents.

```bash
# Single config, all 15 tasks
bun evals/run.ts --model deepseek:deepseek-v4-flash

# Subset + repetitions
bun evals/run.ts --model deepseek:deepseek-v4-pro --tasks fix-off-by-one,rename-symbol --reps 3

# A/B: model vs model
bun evals/run.ts --baseline deepseek:deepseek-v4-flash --candidate deepseek:deepseek-v4-pro

# A/B: prompt variant (the DeepSWE-style experiment)
bun evals/run.ts \
  --baseline '{"model":"deepseek:deepseek-v4-flash"}' \
  --candidate '{"model":"deepseek:deepseek-v4-flash","appendSystemPrompt":"Before declaring completion, re-run the relevant test command and confirm it passes."}' \
  --reps 3
```

Flags: `--tasks a,b,c` · `--reps N` · `--timeout <seconds per run, default 300>`
· config JSON fields `{name, model, thinkingLevel, appendSystemPrompt}` (a bare
string is shorthand for `{"model": ...}`).

An unset `thinkingLevel` resolves through the machine's `~/.bubble/config.json`
default before the model default — so **pin model AND thinkingLevel explicitly
in any comparison you intend to share or rerun elsewhere**. Every run record
stores what actually ran (`resolvedModel`, `resolvedThinkingLevel`); check
those fields in runs.jsonl when a result looks off.

## Output

- Console: per-task pass matrix (`✔✘E` per repetition), per-config aggregates
  (pass rate, mean wall time, mean tokens, total cost), and — with exactly two
  configs — the paired lift line (`+X.Xpp pass rate · +N output tokens · +$Y`).
- `.eval/<timestamp>/runs.jsonl` — one JSON record per run.
- `.eval/<timestamp>/*.jsonl` — the raw Bubble session file of every run, so
  any pass/fail can be replayed and read.

Baseline and candidate are interleaved per task/repetition so provider-load
drift spreads across both sides.

## Tasks

15 tasks in `tasks.ts`, all scored programmatically (subprocess + file
assertions, no LLM judges): bug fixes (`fix-off-by-one`, `fix-crash-null`,
`fix-async-race`), implementation from spec (`implement-slugify`,
`csv-aggregate`, `regex-extract-emails`, `todo-markdown`, `error-messages`),
multi-file work (`rename-symbol`, `multi-file-feature`, `refactor-dedupe`),
instruction-following (`edit-json-config`, `respect-constraint`,
`gitignore-hygiene`), and test authoring with a mutation check
(`write-tests` — the written tests must fail on a broken median, so vacuous
tests score zero).

Adding a task = one entry in `tasks.ts`: `{id, prompt, setup(dir), score(dir)}`.
Keep scorers deterministic and offline; a flipped result between configs must
mean behavior changed, never judge noise.

## Relationship to terminal-bench

terminal-bench is the public, externally comparable exam. This is the cheap
internal quiz for day-to-day decisions ("does this prompt tweak help?") —
minutes and cents instead of hours, on tasks shaped like Bubble's actual use.
