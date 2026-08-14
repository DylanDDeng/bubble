/**
 * Provider-request fingerprints and raw content-block plumbing.
 *
 * The fingerprint is a structural digest of the projected request (roles,
 * char volumes, JSON byte sizes) used to detect whether a retried request
 * actually changed, and to trace what the model saw.
 */
import { estimateContextTokens } from "../context/budget.js";
import type { Message, ProviderMessage, ProviderMetadataProvider, ProviderRawContentBlock, ToolDefinition } from "../types.js";

export function appendProviderContentBlock(
  message: Extract<Message, { role: "assistant" }>,
  provider: ProviderMetadataProvider,
  block: ProviderRawContentBlock,
): void {
  const current = message.providerMetadata?.[provider]?.contentBlocks ?? [];
  message.providerMetadata = {
    ...message.providerMetadata,
    [provider]: {
      ...message.providerMetadata?.[provider],
      contentBlocks: [...current, cloneProviderRawContentBlock(block)],
    },
  };
}

export function buildProviderRequestFingerprint(
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  providerId: string,
  toolChoice?: string,
): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  let contentChars = 0;
  let reasoningChars = 0;
  let toolResultChars = 0;
  let maxToolResultChars = 0;
  let assistantToolCalls = 0;
  let rawAnthropicBlocks = 0;
  let rawAnthropicThinkingBlocks = 0;
  let rawAnthropicSignatureChars = 0;

  for (const message of messages) {
    roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
    if (message.role === "assistant") {
      contentChars += message.content.length;
      reasoningChars += message.reasoning?.length ?? 0;
      assistantToolCalls += message.toolCalls?.length ?? 0;
      const blocks = message.providerMetadata?.anthropic?.contentBlocks ?? [];
      rawAnthropicBlocks += blocks.length;
      for (const block of blocks) {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          rawAnthropicThinkingBlocks += 1;
        }
        if (typeof block.signature === "string") {
          rawAnthropicSignatureChars += block.signature.length;
        }
      }
    } else if (message.role === "tool") {
      toolResultChars += message.content.length;
      maxToolResultChars = Math.max(maxToolResultChars, message.content.length);
    } else if (message.role === "user") {
      contentChars += typeof message.content === "string"
        ? message.content.length
        : message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : part.image_url.url.length), 0);
    } else {
      contentChars += message.content.length;
    }
  }

  const systemMessages = messages.filter((message) => message.role === "system");
  const bodyMessages = messages.filter((message) => message.role !== "system");
  const systemJsonBytes = Buffer.byteLength(JSON.stringify(systemMessages), "utf8");
  const bodyJsonBytes = Buffer.byteLength(JSON.stringify(bodyMessages), "utf8");
  const toolSchemaJsonBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");

  return {
    roleCounts,
    estimatedTokens: estimateContextTokens(messages as Message[], providerId),
    projectedJsonBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
    systemJsonBytes,
    bodyJsonBytes,
    toolSchemaJsonBytes,
    staticPrefixJsonBytes: Buffer.byteLength(JSON.stringify({
      system: systemMessages,
      tools,
      tool_choice: toolChoice,
    }), "utf8"),
    toolChoice,
    contentChars,
    reasoningChars,
    toolResultChars,
    maxToolResultChars,
    assistantToolCalls,
    rawAnthropicBlocks,
    rawAnthropicThinkingBlocks,
    rawAnthropicSignatureChars,
  };
}

export function cloneProviderRawContentBlock(block: ProviderRawContentBlock): ProviderRawContentBlock {
  return JSON.parse(JSON.stringify(block)) as ProviderRawContentBlock;
}
