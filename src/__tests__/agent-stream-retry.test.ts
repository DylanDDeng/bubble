import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { ProviderStreamInterruptedError } from "../network/retry.js";
import type { AgentEvent, Provider, StreamChunk } from "../types.js";

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("agent stream interruption retry", () => {
  it("discards the partial assistant message and re-issues the request", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        calls += 1;
        if (calls === 1) {
          yield { type: "text", content: "partial answer that gets cut" };
          throw new ProviderStreamInterruptedError("Anthropic connection failed mid-stream.", {
            cause: new Error("The socket connection was closed unexpectedly"),
          });
        }
        yield { type: "text", content: "complete answer" };
      },
      async complete() {
        return "complete";
      },
    };

    const agent = new Agent({ provider, model: "test-model", tools: [] });
    const events = await collect(agent.run("hello", mkdtempSync(join(tmpdir(), "bubble-retry-"))));

    expect(calls).toBe(2);
    const retryEvents = events.filter((event) => event.type === "provider_retry");
    expect(retryEvents).toEqual([
      { type: "provider_retry", attempt: 1, maxAttempts: 2, reason: "Anthropic connection failed mid-stream." },
    ]);

    const assistantMessages = agent.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe("complete answer");
  });

  it("gives up after the retry budget and surfaces the error", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        calls += 1;
        yield { type: "text", content: "partial" };
        throw new ProviderStreamInterruptedError("Anthropic connection failed mid-stream.");
      },
      async complete() {
        return "complete";
      },
    };

    const agent = new Agent({ provider, model: "test-model", tools: [] });
    await expect(collect(agent.run("hello", mkdtempSync(join(tmpdir(), "bubble-retry-")))))
      .rejects.toThrow(/connection failed mid-stream/);
    // 1 initial attempt + 2 retries
    expect(calls).toBe(3);
  });

  it("honors a provider-specific retry limit for explicit terminal errors", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        calls += 1;
        throw new ProviderStreamInterruptedError("OpenRouter provider timeout.", {
          maxRetries: 1,
        });
      },
      async complete() {
        return "complete";
      },
    };

    const agent = new Agent({ provider, model: "test-model", tools: [] });
    await expect(collect(agent.run("hello", mkdtempSync(join(tmpdir(), "bubble-retry-")))))
      .rejects.toThrow(/OpenRouter provider timeout/);
    expect(calls).toBe(2);
  });
});
