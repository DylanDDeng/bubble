/* eslint-disable no-console */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import OpenAI from "openai";
import { projectMessages } from "../context/projector.js";
import { composeSystemPrompt } from "../prompt/compose.js";
import { createAllTools } from "../tools/index.js";
import { toChatCompletionsMessage } from "../provider.js";
import type { Message, ProviderMessage, ToolDefinition } from "../types.js";

// Real-network A/B probe for runtime reminder placement.
//
// Run with:
//   DEEPSEEK_PROBE=1 npx vitest run src/__probes__/deepseek-reminder-cache-probe.test.ts --reporter=verbose --silent=false
//
// It compares:
//   control: same stable system/reminder, then append normal conversation
//   old-style: runtime reminders are merged into the leading system message
//   new-style: runtime reminders stay in the conversation near the active turn
//
// The second request in each scenario appends a new reminder. In old-style
// projection that rewrites the first system message before the stable history,
// while new-style projection keeps the previous request as a byte-identical
// prefix and appends the new reminder after it.

const PROBE_ENABLED = process.env.DEEPSEEK_PROBE === "1";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const RUN_ID = process.env.DEEPSEEK_PROBE_RUN_ID || randomUUID();
const DEEPSEEK_ECHO = { reasoningContentEcho: "all" as const };

interface UsageRow {
  scenario: string;
  turn: number;
  prompt_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  hit_pct: number;
  completion_tokens: number;
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

function selectedTools(): ToolDefinition[] {
  const wanted = new Set(["read", "grep", "bash"]);
  return createAllTools("/repo")
    .filter((tool) => wanted.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function toOpenAiTools(tools: ToolDefinition[]): unknown {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function baseSystemPrompt(scenario: string): string {
  return [
    composeSystemPrompt({
      agentName: "Bubble",
      configuredProvider: "deepseek",
      configuredModel: MODEL,
      configuredModelId: MODEL,
      workingDir: "/repo",
      currentDate: "2026-05-20",
      tools: ["read", "grep", "bash"],
      thinkingLevel: "high",
    }),
    `Cache probe marker: ${RUN_ID}:${scenario}`,
  ].join("\n\n");
}

function stableLongUserPrompt(scenario: string): string {
  const paragraph = [
    `Cache probe stable context for ${RUN_ID}:${scenario}.`,
    "This paragraph represents already-sent conversation history that should remain byte-identical across turns.",
    "The requested task is to inspect a pretend repository, summarize relevant files, and avoid repeating equivalent searches.",
  ].join(" ");
  return Array.from({ length: 36 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n");
}

function oldStyleProjected(input: {
  systemPrompt: string;
  firstUser: string;
  reminder1: string;
  reminder2?: string;
}): ProviderMessage[] {
  const reminders = [
    `Runtime reminder:\n${input.reminder1}`,
    input.reminder2 ? `Runtime reminder:\n${input.reminder2}` : undefined,
  ].filter(Boolean).join("\n\n");
  const system = `${input.systemPrompt}\n\n${reminders}`;
  const messages: ProviderMessage[] = [
    { role: "system", content: system },
    { role: "user", content: input.firstUser },
  ];
  if (input.reminder2) {
    messages.push(
      { role: "assistant", content: "I have reviewed the stable context and will continue from it.", reasoning: "" },
      { role: "user", content: "Continue from the previous context and answer briefly." },
    );
  }
  return messages;
}

function controlProjected(input: {
  systemPrompt: string;
  firstUser: string;
  reminder1: string;
  turn2?: boolean;
}): ProviderMessage[] {
  const system = `${input.systemPrompt}\n\nRuntime reminder:\n${input.reminder1}`;
  const messages: ProviderMessage[] = [
    { role: "system", content: system },
    { role: "user", content: input.firstUser },
  ];
  if (input.turn2) {
    messages.push(
      { role: "assistant", content: "I have reviewed the stable context and will continue from it.", reasoning: "" },
      { role: "user", content: "Continue from the previous context and answer briefly." },
    );
  }
  return messages;
}

function newStyleProjected(input: {
  systemPrompt: string;
  firstUser: string;
  reminder1: string;
  reminder2?: string;
}): ProviderMessage[] {
  const messages: Message[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.firstUser },
    { role: "meta", kind: "system-reminder", content: input.reminder1 },
  ];
  if (input.reminder2) {
    messages.push(
      { role: "assistant", content: "I have reviewed the stable context and will continue from it.", reasoning: "" },
      { role: "user", content: "Continue from the previous context and answer briefly." },
      { role: "meta", kind: "system-reminder", content: input.reminder2 },
    );
  }
  return projectMessages(messages);
}

async function runRequest(
  client: OpenAI,
  scenario: string,
  turn: number,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
): Promise<UsageRow> {
  const body: any = {
    model: MODEL,
    messages: messages.map((m) => toChatCompletionsMessage(m, DEEPSEEK_ECHO)),
    tools: toOpenAiTools(tools),
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    max_tokens: 16,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  };

  const stream = (await client.chat.completions.create(body)) as any;
  let usage: any = undefined;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
  }

  const promptTokens = usage?.prompt_tokens ?? 0;
  const hitTokens = usage?.prompt_cache_hit_tokens ?? 0;
  const missTokens = usage?.prompt_cache_miss_tokens ?? 0;
  return {
    scenario,
    turn,
    prompt_tokens: promptTokens,
    prompt_cache_hit_tokens: hitTokens,
    prompt_cache_miss_tokens: missTokens,
    hit_pct: promptTokens > 0 ? Math.round((hitTokens / promptTokens) * 1000) / 10 : 0,
    completion_tokens: usage?.completion_tokens ?? 0,
  };
}

function printRows(rows: UsageRow[]): void {
  console.log("\n=== DeepSeek runtime reminder cache A/B probe ===");
  console.log(`model: ${MODEL}`);
  console.log(`run id: ${RUN_ID}`);
  console.log("");
  console.log("scenario | turn | prompt | hit    | miss   | hit%   | completion");
  console.log("---------+------+--------+--------+--------+--------+-----------");
  for (const r of rows) {
    console.log([
      r.scenario.padEnd(8),
      String(r.turn).padStart(4),
      String(r.prompt_tokens).padStart(6),
      String(r.prompt_cache_hit_tokens).padStart(6),
      String(r.prompt_cache_miss_tokens).padStart(6),
      `${r.hit_pct}%`.padStart(6),
      String(r.completion_tokens).padStart(9),
    ].join(" | "));
  }

  const oldTurn2 = rows.find((r) => r.scenario === "old" && r.turn === 2);
  const newTurn2 = rows.find((r) => r.scenario === "new" && r.turn === 2);
  const controlTurn2 = rows.find((r) => r.scenario === "control" && r.turn === 2);
  if (oldTurn2 && newTurn2) {
    console.log("");
    console.log(`turn-2 hit delta (new - old): ${newTurn2.prompt_cache_hit_tokens - oldTurn2.prompt_cache_hit_tokens} tokens`);
    console.log(`turn-2 miss delta (new - old): ${newTurn2.prompt_cache_miss_tokens - oldTurn2.prompt_cache_miss_tokens} tokens`);
  }
  if (controlTurn2 && oldTurn2) {
    console.log(`turn-2 hit delta (control - old): ${controlTurn2.prompt_cache_hit_tokens - oldTurn2.prompt_cache_hit_tokens} tokens`);
  }
}

describe("DeepSeek runtime reminder cache A/B probe", () => {
  it.skipIf(!PROBE_ENABLED)("compares old system-merged reminders against in-place runtime reminders", async () => {
    const { apiKey, baseURL } = await loadDeepSeekProfile();
    const client = new OpenAI({ apiKey, baseURL });
    const tools = selectedTools();
    const reminder1 = "Debugging workflow: reproduce the boundary before editing.";
    const reminder2 = "Code explanation workflow: answer directly and avoid unnecessary edits.";

    const controlSystem = baseSystemPrompt("control");
    const controlUser = stableLongUserPrompt("control");
    const oldSystem = baseSystemPrompt("old");
    const oldUser = stableLongUserPrompt("old");
    const newSystem = baseSystemPrompt("new");
    const newUser = stableLongUserPrompt("new");

    const rows: UsageRow[] = [];
    rows.push(await runRequest(client, "control", 1, controlProjected({
      systemPrompt: controlSystem,
      firstUser: controlUser,
      reminder1,
    }), tools));
    rows.push(await runRequest(client, "control", 2, controlProjected({
      systemPrompt: controlSystem,
      firstUser: controlUser,
      reminder1,
      turn2: true,
    }), tools));
    rows.push(await runRequest(client, "old", 1, oldStyleProjected({
      systemPrompt: oldSystem,
      firstUser: oldUser,
      reminder1,
    }), tools));
    rows.push(await runRequest(client, "old", 2, oldStyleProjected({
      systemPrompt: oldSystem,
      firstUser: oldUser,
      reminder1,
      reminder2,
    }), tools));
    rows.push(await runRequest(client, "new", 1, newStyleProjected({
      systemPrompt: newSystem,
      firstUser: newUser,
      reminder1,
    }), tools));
    rows.push(await runRequest(client, "new", 2, newStyleProjected({
      systemPrompt: newSystem,
      firstUser: newUser,
      reminder1,
      reminder2,
    }), tools));

    printRows(rows);
  }, 180_000);
});
