/* eslint-disable no-console */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import OpenAI from "openai";
import { composeSystemPrompt } from "../prompt/compose.js";
import { createAllTools } from "../tools/index.js";
import { toChatCompletionsMessage } from "../provider.js";
import type { ProviderMessage, ToolDefinition } from "../types.js";

// DeepSeek prompt-cache hit-rate probe.
//
// This is a *real network* probe, not a unit test. It is gated behind
// `DEEPSEEK_PROBE=1` so it never runs as part of `npm test`. Run with:
//
//     DEEPSEEK_PROBE=1 npx vitest run src/__probes__/deepseek-cache-probe.test.ts
//
// The probe simulates a short multi-turn coding session against DeepSeek and
// reports per-turn `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`,
// so we can decide whether the current pipeline already cache-hits well or
// whether structural changes are warranted.

const PROBE_ENABLED = process.env.DEEPSEEK_PROBE === "1";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

interface TurnResult {
  turn: number;
  prompt_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  hit_pct: number;
  completion_tokens: number;
  reply_preview: string;
}

async function loadDeepSeekProfile(): Promise<{ apiKey: string; baseURL: string }> {
  const raw = await readFile(join(homedir(), ".bubble", "config.json"), "utf-8");
  const cfg = JSON.parse(raw);
  const provider = (cfg.providers ?? []).find((p: any) => p.id === "deepseek");
  if (!provider?.apiKey) {
    throw new Error("No DeepSeek provider configured in ~/.bubble/config.json");
  }
  return { apiKey: provider.apiKey, baseURL: provider.baseURL || "https://api.deepseek.com" };
}

function toOpenAiTools(tools: ToolDefinition[]): any {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters as any },
  }));
}

async function runTurn(
  client: OpenAI,
  turn: number,
  systemPrompt: string,
  tools: ToolDefinition[],
  history: ProviderMessage[],
): Promise<{ result: TurnResult; assistantMessage: ProviderMessage }> {
  const body: any = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((m) => toChatCompletionsMessage(m, { reasoningContentEcho: "tool_calls" })),
    ],
    tools: toOpenAiTools(tools),
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    max_tokens: 80,
  };

  const stream = (await client.chat.completions.create(body)) as any;

  let content = "";
  let usage: any = undefined;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    if (chunk.usage) usage = chunk.usage;
  }

  const promptTokens = usage?.prompt_tokens ?? 0;
  const hitTokens = usage?.prompt_cache_hit_tokens ?? 0;
  const missTokens = usage?.prompt_cache_miss_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;

  const result: TurnResult = {
    turn,
    prompt_tokens: promptTokens,
    prompt_cache_hit_tokens: hitTokens,
    prompt_cache_miss_tokens: missTokens,
    hit_pct: promptTokens > 0 ? Math.round((hitTokens / promptTokens) * 1000) / 10 : 0,
    completion_tokens: completionTokens,
    reply_preview: content.slice(0, 60).replace(/\n/g, " "),
  };

  const assistantMessage: ProviderMessage = { role: "assistant", content };
  return { result, assistantMessage };
}

function printTable(rows: TurnResult[]): void {
  console.log("\n=== DeepSeek cache probe results ===");
  console.log(`model: ${MODEL}`);
  console.log("");
  console.log("turn | prompt | hit    | miss   | hit%   | completion | reply");
  console.log("-----+--------+--------+--------+--------+------------+-----------------------------");
  for (const r of rows) {
    console.log(
      [
        String(r.turn).padStart(4),
        String(r.prompt_tokens).padStart(6),
        String(r.prompt_cache_hit_tokens).padStart(6),
        String(r.prompt_cache_miss_tokens).padStart(6),
        (r.hit_pct + "%").padStart(6),
        String(r.completion_tokens).padStart(10),
        r.reply_preview,
      ].join(" | "),
    );
  }
  console.log("");
  const totalPrompt = rows.reduce((s, r) => s + r.prompt_tokens, 0);
  const totalHit = rows.reduce((s, r) => s + r.prompt_cache_hit_tokens, 0);
  const overall = totalPrompt > 0 ? ((totalHit / totalPrompt) * 100).toFixed(1) : "0";
  console.log(`overall hit rate across all turns: ${totalHit}/${totalPrompt} = ${overall}%`);
}

describe("DeepSeek cache hit-rate probe", () => {
  it.skipIf(!PROBE_ENABLED)("runs a multi-turn session and reports cache hit tokens", async () => {
    const { apiKey, baseURL } = await loadDeepSeekProfile();
    const client = new OpenAI({ apiKey, baseURL });

    const systemPrompt = composeSystemPrompt({
      agentName: "Bubble",
      configuredProvider: "deepseek",
      configuredModel: MODEL,
      configuredModelId: MODEL,
      workingDir: "/repo",
      currentDate: "2026-05-20",
      thinkingLevel: "off",
    });
    const tools = createAllTools("/repo");

    console.log(`system prompt length: ${systemPrompt.length} chars`);
    console.log(`tools: ${tools.length}`);

    const userPrompts = [
      "Hi, what is 2+2?",
      "And what about 3+3?",
      "Can you show me how to add numbers in TypeScript?",
      "What's the difference between let and const?",
      "Thanks. Last question: what's 5*5?",
    ];

    const history: ProviderMessage[] = [];
    const rows: TurnResult[] = [];

    for (let i = 0; i < userPrompts.length; i += 1) {
      history.push({ role: "user", content: userPrompts[i] });
      const { result, assistantMessage } = await runTurn(client, i + 1, systemPrompt, tools, history);
      rows.push(result);
      history.push(assistantMessage);
    }

    printTable(rows);

    // Second run with identical first user message — does cross-session
    // common-prefix detection give us a turn-1 hit?
    console.log("\n--- second session, identical turn 1 ---");
    const session2History: ProviderMessage[] = [
      { role: "user", content: userPrompts[0] },
    ];
    const { result: s2t1 } = await runTurn(client, 1, systemPrompt, tools, session2History);
    printTable([s2t1]);
  }, 180_000);
});
