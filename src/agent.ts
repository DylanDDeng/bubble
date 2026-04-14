/**
 * Agent - The core decision loop.
 *
 * This is a simplified version of pi-agent-core's Agent class.
 * It maintains message state, calls the LLM, executes tools, and auto-continues.
 */

import type { AgentEvent, Message, ParsedToolCall, Provider, ToolDefinition, ToolResult, ToolRegistryEntry } from "./types.js";

export interface AgentOptions {
  provider: Provider;
  model: string;
  tools: ToolRegistryEntry[];
  temperature?: number;
  reasoning?: boolean;
  systemPrompt?: string;
  onMessageAppend?: (message: Message) => void;
}

export class Agent {
  messages: Message[] = [];
  private provider: Provider;
  private _model: string;
  private tools: Map<string, ToolRegistryEntry> = new Map();
  private temperature: number;
  private reasoning?: boolean;
  private onMessageAppend?: (message: Message) => void;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this._model = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.reasoning = options.reasoning;
    this.onMessageAppend = options.onMessageAppend;

    if (options.systemPrompt) {
      this.messages.push({ role: "system", content: options.systemPrompt });
    }

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get model(): string {
    return this._model;
  }

  set model(value: string) {
    this._model = value;
  }

  setProvider(provider: Provider) {
    this.provider = provider;
  }

  async *run(userInput: string, cwd: string): AsyncIterable<AgentEvent> {
    this.appendMessage({ role: "user", content: userInput });

    while (true) {
      yield { type: "turn_start" };

      const assistantMsg: Extract<Message, { role: "assistant" }> = {
        role: "assistant",
        content: "",
        reasoning: "",
        toolCalls: [],
      };

      let currentToolCall: { id: string; name: string; args: string } | null = null;
      let turnUsage: { promptTokens: number; completionTokens: number } | undefined;

      const toolDefinitions: ToolDefinition[] = Array.from(this.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      const stream = this.provider.streamChat(this.messages, {
        model: this.model,
        tools: toolDefinitions,
        temperature: this.temperature,
        reasoning: this.reasoning,
      });

      for await (const chunk of stream) {
        switch (chunk.type) {
          case "text":
            assistantMsg.content += chunk.content;
            yield { type: "text_delta", content: chunk.content };
            break;
          case "reasoning_delta":
            assistantMsg.reasoning = (assistantMsg.reasoning || "") + chunk.content;
            yield { type: "reasoning_delta", content: chunk.content };
            break;

          case "tool_call":
            if (chunk.isStart) {
              currentToolCall = { id: chunk.id, name: chunk.name, args: "" };
            }
            if (currentToolCall) {
              currentToolCall.args += chunk.arguments;
            }
            if (chunk.isEnd && currentToolCall) {
              assistantMsg.toolCalls!.push({
                id: currentToolCall.id,
                name: currentToolCall.name,
                arguments: currentToolCall.args,
              });
              currentToolCall = null;
            }
            break;

          case "usage":
            turnUsage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
            break;
        }
      }

      this.appendMessage(assistantMsg);

      // Execute tools if any
      if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
        const parsedCalls: ParsedToolCall[] = [];
        for (const tc of assistantMsg.toolCalls) {
          try {
            parsedCalls.push({ ...tc, parsedArgs: JSON.parse(tc.arguments) });
          } catch {
            parsedCalls.push({ ...tc, parsedArgs: {} });
          }
        }

        for (const tc of parsedCalls) {
          yield { type: "tool_start", id: tc.id, name: tc.name, args: tc.parsedArgs };
          const result = await this.executeTool(tc, cwd);
          this.appendMessage({
            role: "tool",
            toolCallId: tc.id,
            content: result.content,
          });
          yield { type: "tool_end", id: tc.id, name: tc.name, result };
        }

        // Auto-continue: if we have tool results, the LLM needs to respond to them
        continue;
      }

      yield { type: "turn_end", usage: turnUsage };
      break;
    }

    yield { type: "agent_end" };
  }

  private appendMessage(message: Message) {
    this.messages.push(message);
    this.onMessageAppend?.(message);
  }

  private async executeTool(toolCall: ParsedToolCall, cwd: string): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        content: `Error: Unknown tool "${toolCall.name}"`,
        isError: true,
      };
    }

    try {
      return await tool.execute(toolCall.parsedArgs, { cwd });
    } catch (err: any) {
      return {
        content: `Error executing ${toolCall.name}: ${err.message || String(err)}`,
        isError: true,
      };
    }
  }
}
