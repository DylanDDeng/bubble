import type { Message, Provider, StreamChunk, ToolDefinition } from "./types.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES = "responses=experimental";
const CODEX_CLIENT_VERSION = "0.121.0";
const MODEL_DISCOVERY_PATHS = [
  `/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
  "/models",
];

const FALLBACK_MODEL_ORDER = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.1",
] as const;

export function isOpenAICodexBaseUrl(baseURL: string): boolean {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_CODEX_BASE_URL || normalized.startsWith(`${DEFAULT_CODEX_BASE_URL}/`);
}

export function getOpenAICodexFallbackModels(): string[] {
  return [...FALLBACK_MODEL_ORDER];
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, any>;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id) {
      return auth.chatgpt_account_id;
    }
    if (typeof auth?.account_id === "string" && auth.account_id) {
      return auth.account_id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createOpenAICodexProvider(options: {
  apiKey: string;
  baseURL: string;
  reasoning?: boolean;
}): Provider {
  async function* streamChat(
    messages: Message[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; reasoning?: boolean }
  ): AsyncIterable<StreamChunk> {
    const accountId = extractChatGptAccountId(options.apiKey);
    if (!accountId) {
      throw new Error("Failed to extract chatgpt_account_id from ChatGPT OAuth token.");
    }

    const response = await fetch(resolveCodexUrl(options.baseURL), {
      method: "POST",
      headers: buildSseHeaders(options.apiKey, accountId),
      body: JSON.stringify(
        buildRequestBody(messages, {
          model: chatOptions.model,
          tools: chatOptions.tools,
          reasoning: chatOptions.reasoning ?? options.reasoning,
        })
      ),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${response.status} status code${errorText ? `: ${errorText}` : " (no body)"}`);
    }

    let currentToolCall:
      | {
          id: string;
          name: string;
          args: string;
          started: boolean;
        }
      | undefined;

    for await (const event of parseSse(response)) {
      const type = typeof event.type === "string" ? event.type : undefined;
      if (!type) continue;

      if (type === "error") {
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        throw new Error(message);
      }

      if (type === "response.failed") {
        const message = typeof (event.response as any)?.error?.message === "string"
          ? (event.response as any).error.message
          : "Codex response failed";
        throw new Error(message);
      }

      if (type === "response.output_item.added") {
        const item = (event as any).item;
        if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
          currentToolCall = {
            id: item.call_id,
            name: item.name,
            args: typeof item.arguments === "string" ? item.arguments : "",
            started: true,
          };
          yield {
            type: "tool_call",
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: "",
            isStart: true,
            isEnd: false,
          };
        }
        continue;
      }

      if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
        if (delta) {
          yield { type: "text", content: delta };
        }
        continue;
      }

      if (type === "response.reasoning_summary_text.delta") {
        const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
        if (delta) {
          yield { type: "reasoning_delta", content: delta };
        }
        continue;
      }

      if (type === "response.function_call_arguments.delta" && currentToolCall) {
        const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
        if (delta) {
          currentToolCall.args += delta;
          yield {
            type: "tool_call",
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: delta,
            isStart: false,
            isEnd: false,
          };
        }
        continue;
      }

      if (type === "response.function_call_arguments.done" && currentToolCall) {
        const finalArgs = typeof (event as any).arguments === "string" ? (event as any).arguments : currentToolCall.args;
        if (finalArgs.startsWith(currentToolCall.args)) {
          const tail = finalArgs.slice(currentToolCall.args.length);
          if (tail) {
            currentToolCall.args = finalArgs;
            yield {
              type: "tool_call",
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: tail,
              isStart: false,
              isEnd: false,
            };
          }
        } else {
          currentToolCall.args = finalArgs;
        }
        continue;
      }

      if (type === "response.output_item.done" && currentToolCall) {
        const item = (event as any).item;
        if (item?.type === "function_call" && item.call_id === currentToolCall.id) {
          yield {
            type: "tool_call",
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: "",
            isStart: false,
            isEnd: true,
          };
          currentToolCall = undefined;
        }
        continue;
      }

      if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
        const usage = (event as any).response?.usage;
        if (usage) {
          yield {
            type: "usage",
            promptTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
            completionTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          };
        }
        continue;
      }
    }

    yield { type: "done" };
  }

  async function complete(
    messages: Message[],
    chatOptions?: { model?: string; temperature?: number; reasoning?: boolean }
  ): Promise<string> {
    let content = "";
    for await (const chunk of streamChat(messages, {
      model: chatOptions?.model ?? "gpt-5.4",
      temperature: chatOptions?.temperature,
      reasoning: chatOptions?.reasoning,
    })) {
      if (chunk.type === "text") {
        content += chunk.content;
      }
    }
    return content;
  }

  return { streamChat, complete };
}

export async function fetchOpenAICodexModels(options: {
  baseURL: string;
  accessToken: string;
}): Promise<string[]> {
  const accountId = extractChatGptAccountId(options.accessToken);
  if (!accountId) {
    return [];
  }

  for (const path of MODEL_DISCOVERY_PATHS) {
    const response = await fetch(resolveRelativeUrl(options.baseURL, path), {
      method: "GET",
      headers: buildBaseHeaders(options.accessToken, accountId, { accept: "application/json" }),
    }).catch(() => undefined);

    if (!response?.ok) continue;

    const payload = await response.json().catch(() => undefined);
    const ids = extractModelIds(payload);
    if (ids.length > 0) {
      return sortCodexModelIds(ids);
    }
  }

  return [];
}

function buildRequestBody(
  messages: Message[],
  options: {
    model: string;
    tools?: ToolDefinition[];
    reasoning?: boolean;
  }
) {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const input = messages.flatMap((message) => convertMessage(message));
  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    instructions: instructions || undefined,
    input,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    text: { verbosity: "medium" },
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  if (options.reasoning) {
    body.reasoning = { effort: "medium", summary: "auto" };
  }

  return body;
}

function convertMessage(message: Message): Array<Record<string, unknown>> {
  if (message.role === "system") {
    return [];
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return [{
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      }];
    }

    return [{
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "input_text", text: part.text };
        }
        return { type: "input_image", detail: "auto", image_url: part.image_url.url };
      }),
    }];
  }

  if (message.role === "assistant") {
    const items: Array<Record<string, unknown>> = [];
    if (message.content) {
      items.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.content, annotations: [] }],
      });
    }
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments || "{}",
        });
      }
    }
    return items;
  }

  return [{
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content,
  }];
}

async function* parseSse(response: Response): AsyncIterable<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Ignore malformed events.
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function buildBaseHeaders(
  accessToken: string,
  accountId: string,
  extraHeaders?: Record<string, string>
): Headers {
  const headers = new Headers(extraHeaders);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "my-coding-agent");
  headers.set("User-Agent", "my-coding-agent");
  return headers;
}

function buildSseHeaders(accessToken: string, accountId: string): Headers {
  const headers = buildBaseHeaders(accessToken, accountId, {
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES);
  return headers;
}

function resolveCodexUrl(baseURL: string): string {
  const normalized = (baseURL.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function resolveRelativeUrl(baseURL: string, path: string): string {
  const normalized = (baseURL.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  return `${normalized}${path}`;
}

function extractModelIds(payload: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const maybeAdd = (value: unknown) => {
    if (typeof value !== "string") return;
    if (!/^gpt-|^codex-/i.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") {
      maybeAdd(value);
      return;
    }

    const record = value as Record<string, unknown>;
    maybeAdd(record.id);
    maybeAdd(record.slug);
    maybeAdd(record.model);
    maybeAdd(record.model_slug);

    for (const child of Object.values(record)) {
      if (child !== record.id && child !== record.slug && child !== record.model && child !== record.model_slug) {
        visit(child);
      }
    }
  };

  visit(payload);
  return ids;
}

function sortCodexModelIds(ids: string[]): string[] {
  const preferred = new Map<string, number>(FALLBACK_MODEL_ORDER.map((id, index) => [id, index]));
  return [...ids].sort((left, right) => {
    const leftRank = preferred.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = preferred.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}
