/* eslint-disable no-console */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesProvider } from "../provider-anthropic.js";
import type { ProviderMessage, TokenUsage, ToolDefinition } from "../types.js";

// Anthropic message-region prompt-cache probe.
//
// A *real network* probe, gated behind `ANTHROPIC_PROBE=1` so it never runs in
// `npm test`. Run with:
//
//     ANTHROPIC_PROBE=1 npx vitest run src/__probes__/anthropic-cache-probe.test.ts
//
// Unlike the offline simulator, this sends the request that
// buildAnthropicRequest actually produces, so it validates the shipped code
// path rather than a model of it. It replays a short agent loop twice — once
// with message breakpoints disabled (today's behaviour) and once enabled — and
// asserts the enabled run reads back the previous turn's whole context.
//
// Costs a few cents per run on claude-opus-4-8.

const PROBE_ENABLED = process.env.ANTHROPIC_PROBE === "1";
const MODEL = process.env.ANTHROPIC_PROBE_MODEL || "claude-opus-4-8";

async function loadApiKey(): Promise<string> {
  const raw = await readFile(join(homedir(), ".bubble", "config.json"), "utf8");
  const parsed = JSON.parse(raw) as { providers?: Array<{ id?: string; apiKey?: string }> };
  const key = parsed.providers?.find((provider) => provider.id === "anthropic")?.apiKey;
  if (!key) throw new Error("no anthropic apiKey in ~/.bubble/config.json");
  return key;
}

const readTool: ToolDefinition = {
  name: "read",
  description: "Read the contents of a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

// Big enough that the cacheable prefix clears the model minimum and the
// per-turn delta is visible in the token counts.
const SYSTEM = "You are a meticulous software engineering agent. ".repeat(120);
const FILE_BODY = "export function handler(request, context) { return normalize(request); }\n".repeat(60);

function history(turns: number): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Summarize every handler in this repository." },
  ];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      role: "assistant",
      content: `Reading file ${turn + 1}.`,
      toolCalls: [{ id: `read_${turn}`, name: "read", arguments: JSON.stringify({ path: `src/mod_${turn}.ts` }) }],
    });
    messages.push({ role: "tool", toolCallId: `read_${turn}`, content: `// src/mod_${turn}.ts\n${FILE_BODY}` });
  }
  return messages;
}

async function send(apiKey: string, turns: number, salt: string): Promise<TokenUsage> {
  const messages = history(turns);
  // Salt the system prompt per mode so the two runs cannot read each other's
  // cache entries — that contamination silently "proved" a broken variant works.
  messages[0] = { role: "system", content: `${SYSTEM}\nSession ${salt}.` };

  // Drive the real provider rather than hand-rolling the HTTP call: this way
  // the probe covers request building, the configured transport (including
  // proxy handling) and mergeAnthropicUsage, not just breakpoint placement.
  const provider = createAnthropicMessagesProvider({
    providerId: "anthropic",
    apiKey,
    baseURL: "https://api.anthropic.com",
  });

  let usage: TokenUsage | undefined;
  for await (const chunk of provider.streamChat(messages, { model: MODEL, tools: [readTool] })) {
    if (chunk.type === "usage") usage = chunk.usage;
  }
  if (!usage) throw new Error("provider reported no usage");
  return usage;
}

function report(label: string, usage: TokenUsage): number {
  const read = usage.promptCacheHitTokens ?? 0;
  const create = usage.cacheCreationTokens ?? 0;
  const fresh = Math.max(0, (usage.promptCacheMissTokens ?? 0) - create);
  const total = read + create + fresh;
  console.log(
    `${label.padEnd(26)} read=${String(read).padStart(7)} create=${String(create).padStart(7)}`
    + ` uncached=${String(fresh).padStart(5)} total=${String(total).padStart(7)}`
    + ` hit=${total ? ((read / total) * 100).toFixed(1) : "0.0"}%`,
  );
  return total;
}

describe.skipIf(!PROBE_ENABLED)("anthropic prompt cache (live)", () => {
  it("reads back the previous turn's whole context once message breakpoints are on", async () => {
    const apiKey = await loadApiKey();
    const salt = `probe-${process.pid}`;

    // Baseline: kill switch on, i.e. what shipped before this change.
    process.env.BUBBLE_ANTHROPIC_MESSAGE_CACHE = "0";
    const baselineTotals: number[] = [];
    const baselineUsage: TokenUsage[] = [];
    for (const turns of [2, 3, 4]) {
      const usage = await send(apiKey, turns, `${salt}-off`);
      baselineTotals.push(report(`off  turn ${turns}`, usage));
      baselineUsage.push(usage);
    }

    delete process.env.BUBBLE_ANTHROPIC_MESSAGE_CACHE;
    const totals: number[] = [];
    const usages: TokenUsage[] = [];
    for (const turns of [2, 3, 4]) {
      const usage = await send(apiKey, turns, `${salt}-on`);
      totals.push(report(`on   turn ${turns}`, usage));
      usages.push(usage);
    }

    // Without message breakpoints only the static system+tools prefix caches,
    // so the read count stays flat while the prompt grows.
    expect(baselineUsage[2].promptCacheHitTokens ?? 0)
      .toBe(baselineUsage[1].promptCacheHitTokens ?? 0);

    // With them, each turn reads back exactly what the previous turn cached:
    // read(N) === read(N-1) + create(N-1). Note this is a couple of tokens shy
    // of the previous turn's grand total — the API counts a small amount of
    // message framing after the final breakpoint, which is the "uncached=2"
    // column above and is not cacheable by construction.
    const cachedAfter = (usage: TokenUsage) =>
      (usage.promptCacheHitTokens ?? 0) + (usage.cacheCreationTokens ?? 0);

    expect(usages[1].promptCacheHitTokens ?? 0).toBe(cachedAfter(usages[0]));
    expect(usages[2].promptCacheHitTokens ?? 0).toBe(cachedAfter(usages[1]));

    // And the improvement is economic, not cosmetic. The billed quantity is
    // "fresh work" — tokens written plus tokens left uncached — since reads are
    // a tenth the price. Baseline re-does the whole history every turn; fixed
    // does only the delta. (Hit RATE alone understates this on a 3-turn toy,
    // where the static system prefix is a large share of a small prompt; in a
    // real run the baseline rate decays toward zero as history grows.)
    const fresh = (usage: TokenUsage) => usage.promptCacheMissTokens ?? 0;
    const baselineHit = (baselineUsage[2].promptCacheHitTokens ?? 0) / baselineTotals[2];
    const fixedHit = (usages[2].promptCacheHitTokens ?? 0) / totals[2];
    console.log(
      `baseline hit ${(baselineHit * 100).toFixed(1)}% -> fixed hit ${(fixedHit * 100).toFixed(1)}%`
      + ` | fresh tokens ${fresh(baselineUsage[2])} -> ${fresh(usages[2])}`,
    );
    expect(fixedHit).toBeGreaterThan(0.6);
    expect(fixedHit).toBeGreaterThan(baselineHit);
    expect(fresh(usages[2])).toBeLessThan(fresh(baselineUsage[2]) / 2);
  }, 300_000);
});
