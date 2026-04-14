/**
 * OpenAI-compatible Provider implementation.
 *
 * Works with OpenRouter, OpenAI, DeepSeek, Google, Groq, Together, and local OpenAI-compatible endpoints.
 */

import OpenAI from "openai";
import type { Message, Provider, StreamChunk, ToolDefinition } from "./types.js";

export interface ProviderInstanceOptions {
  apiKey: string;
  baseURL: string;
  /** Whether to request reasoning mode */
  reasoning?: boolean;
}

export function createProviderInstance(options: ProviderInstanceOptions): Provider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  async function* streamChat(
    messages: Message[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; reasoning?: boolean }
  ): AsyncIterable<StreamChunk> {
    const tools = chatOptions.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
      },
    }));

    const body: any = {
      model: chatOptions.model,
      messages: messages as any,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? "auto" : undefined,
      temperature: chatOptions.temperature ?? 0.2,
      stream: true,
    };

    if (chatOptions.reasoning) {
      body.reasoning = { enabled: true };
    }

    const stream = (await client.chat.completions.create(body as any)) as any;

    let currentToolCall: { id?: string; name?: string; args: string } | null = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const usage = (chunk as any).usage;

      if (usage) {
        yield {
          type: "usage",
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
        };
      }

      const reasoning = (delta as any)?.reasoning ?? (delta as any)?.thinking;
      if (reasoning) {
        yield { type: "reasoning_delta", content: reasoning };
      }

      if (delta?.content) {
        const thinkMatch = delta.content.match(/<think>([\s\S]*?)<\/think>/);
        if (thinkMatch) {
          if (thinkMatch[1]) {
            yield { type: "reasoning_delta", content: thinkMatch[1] };
          }
          const remaining = delta.content.replace(/<think>[\s\S]*?<\/think>/, "");
          if (remaining) {
            yield { type: "text", content: remaining };
          }
        } else {
          yield { type: "text", content: delta.content };
        }
      }

      if (delta?.tool_calls) {
        const tc = delta.tool_calls[0];
        if (tc.id && tc.function?.name) {
          currentToolCall = { id: tc.id, name: tc.function.name, args: "" };
          yield {
            type: "tool_call",
            id: tc.id,
            name: tc.function.name,
            arguments: "",
            isStart: true,
            isEnd: false,
          };
        } else if (currentToolCall && tc.function?.arguments) {
          currentToolCall.args += tc.function.arguments;
          yield {
            type: "tool_call",
            id: currentToolCall.id!,
            name: currentToolCall.name!,
            arguments: tc.function.arguments,
            isStart: false,
            isEnd: false,
          };
        }
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === "tool_calls" && currentToolCall) {
        yield {
          type: "tool_call",
          id: currentToolCall.id!,
          name: currentToolCall.name!,
          arguments: "",
          isStart: false,
          isEnd: true,
        };
        currentToolCall = null;
      }
    }

    yield { type: "done" };
  }

  async function complete(messages: Message[], chatOptions?: { model?: string; temperature?: number; reasoning?: boolean }): Promise<string> {
    const body: any = {
      model: chatOptions?.model ?? "z-ai/glm-5.1",
      messages: messages as any,
      temperature: chatOptions?.temperature ?? 0.2,
    };
    if (chatOptions?.reasoning) {
      body.reasoning = { enabled: true };
    }
    const response = await client.chat.completions.create(body);
    return response.choices[0]?.message?.content ?? "";
  }

  return { streamChat, complete };
}
