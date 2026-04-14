import React, { useCallback, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { AgentEvent, Message, Provider } from "../types.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { UserConfig, maskKey } from "../config.js";
import { InputBox } from "./input-box.js";
import { MessageList, type DisplayMessage, type DisplayToolCall } from "./message-list.js";
import { theme } from "./theme.js";
import { ModelPicker, ProviderPicker, KeyPicker } from "./model-picker.js";
import { ProviderRegistry, encodeModel, displayModel } from "../provider-registry.js";

interface AppProps {
  agent: Agent;
  args: CliArgs;
  sessionManager?: SessionManager;
  createProvider?: (apiKey: string, baseURL: string) => Provider;
  registry?: ProviderRegistry;
}

function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const m of agentMessages) {
    if (m.role === "system" || m.role === "tool") continue;
    if (m.role === "user") {
      result.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : "(multimedia)",
      });
    } else if (m.role === "assistant") {
      const toolCalls: DisplayToolCall[] = [];
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.arguments || "{}") as Record<string, any>;
          } catch {
            args = {};
          }
          const toolResult = agentMessages.find(
            (tm) => tm.role === "tool" && (tm as any).toolCallId === tc.id
          );
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: toolResult ? (toolResult as any).content as string : undefined,
            isError: toolResult ? (toolResult as any).content?.startsWith?.("Error:") : false,
          });
        }
      }
      result.push({
        role: "assistant",
        content: m.content,
        reasoning: m.reasoning || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }
  return result;
}

export function App({ agent, args, sessionManager, createProvider, registry }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => reconstructDisplayMessages(agent.messages));
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);
  const [pickerMode, setPickerMode] = useState<"model" | "key" | "provider" | null>(null);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);

  const userConfig = new UserConfig();
  const safeRegistry = registry ?? new ProviderRegistry(userConfig);

  useInput((_input, key) => {
    if (key.escape && !pickerMode) {
      exit();
    }
  });

  const addMessage = useCallback((role: DisplayMessage["role"], content: string) => {
    setMessages((prev) => [...prev, { role, content }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const openPicker = useCallback((mode: "model" | "key" | "provider") => {
    setPickerMode(mode);
  }, []);

  const handleModelSelect = useCallback((model: string) => {
    agent.model = model;
    const decoded = model.includes(":") ? model.split(":") : [agent.providerId || safeRegistry.getDefault()?.id || "openrouter", model];
    agent.providerId = decoded[0];
    userConfig.pushRecentModel(model);
    sessionManager?.setMetadata({ model });
    addMessage("assistant", `Model switched to ${displayModel(model)}.`);
    setPickerMode(null);
  }, [agent, addMessage, sessionManager, userConfig, safeRegistry]);

  const handleProviderSelect = useCallback((providerId: string) => {
    const providers = safeRegistry.getConfigured();
    const p = providers.find((x) => x.id === providerId);
    if (!p) {
      addMessage("error", `Provider ${providerId} not found.`);
      setPickerMode(null);
      return;
    }
    if (!p.apiKey) {
      setKeyProviderId(providerId);
      setPickerMode("key");
      return;
    }
    safeRegistry.setDefault(providerId);
    agent.setProvider(createProvider!(p.apiKey, p.baseURL));
    agent.providerId = providerId;
    addMessage("assistant", `Switched to provider ${p.name}. Use /model to pick a model.`);
    setPickerMode(null);
  }, [addMessage, agent, createProvider, safeRegistry]);

  const handleKeySubmit = useCallback((key: string) => {
    const targetId = keyProviderId || safeRegistry.getDefault()?.id;
    if (!targetId) {
      addMessage("error", "No provider selected.");
      setPickerMode(null);
      setKeyProviderId(null);
      return;
    }
    safeRegistry.updateProviderKey(targetId, key);
    const p = safeRegistry.getConfigured().find((x) => x.id === targetId);
    if (p && createProvider) {
      agent.setProvider(createProvider(key, p.baseURL));
      agent.providerId = targetId;
    }
    addMessage("assistant", `API key updated for ${p?.name || targetId} to ${maskKey(key)}.`);
    setPickerMode(null);
    setKeyProviderId(null);
  }, [addMessage, agent, createProvider, keyProviderId, safeRegistry]);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // Intercept slash commands
      if (input.startsWith("/")) {
        const { handled, result } = await slashRegistry.execute(input, {
          agent,
          addMessage,
          clearMessages,
          exit,
          sessionManager,
          createProvider: createProvider ?? (() => {
            throw new Error("Provider creation not available");
          }),
          openPicker,
          registry: safeRegistry,
        });
        if (handled) {
          if (result) {
            addMessage("assistant", result);
          }
          return;
        }
      }

      setMessages((prev) => [...prev, { role: "user", content: input }]);
      setIsRunning(true);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingTools([]);

      let assistantContent = "";
      let assistantReasoning = "";
      const toolCalls: DisplayToolCall[] = [];

      try {
        for await (const event of agent.run(input, args.cwd)) {
          switch (event.type) {
            case "text_delta":
              assistantContent += event.content;
              setStreamingContent(assistantContent);
              break;
            case "reasoning_delta":
              assistantReasoning += event.content;
              setStreamingReasoning(assistantReasoning);
              break;
            case "tool_start": {
              const tc: DisplayToolCall = {
                id: event.id,
                name: event.name,
                args: event.args,
              };
              toolCalls.push(tc);
              setStreamingTools([...toolCalls]);
              break;
            }
            case "tool_end": {
              const tc = toolCalls.find((t) => t.id === event.id);
              if (tc) {
                tc.result = event.result.content;
                tc.isError = event.result.isError;
                setStreamingTools([...toolCalls]);
              }
              break;
            }
            case "turn_end": {
              const currentContent = assistantContent;
              const currentReasoning = assistantReasoning;
              const currentToolCalls = [...toolCalls];
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  const merged: DisplayMessage = {
                    ...last,
                    reasoning: currentReasoning || last.reasoning,
                    content:
                      last.content && currentContent
                        ? last.content + "\n" + currentContent
                        : last.content + currentContent,
                    toolCalls: [...(last.toolCalls || []), ...currentToolCalls],
                  };
                  return [...prev.slice(0, -1), merged];
                }
                const msg: DisplayMessage = {
                  role: "assistant",
                  content: currentContent,
                };
                if (currentReasoning) {
                  msg.reasoning = currentReasoning;
                }
                if (currentToolCalls.length > 0) {
                  msg.toolCalls = currentToolCalls;
                }
                return [...prev, msg];
              });
              setStreamingContent("");
              setStreamingReasoning("");
              setStreamingTools([]);
              assistantContent = "";
              assistantReasoning = "";
              toolCalls.length = 0;
              break;
            }
          }
        }
      } catch (err: any) {
        setMessages((prev) => [...prev, { role: "error", content: err.message }]);
      } finally {
        setIsRunning(false);
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingTools([]);
      }
    },
    [agent, args.cwd, openPicker, createProvider, safeRegistry]
  );

  const currentProviderId = agent.providerId || safeRegistry.getDefault()?.id;
  const keyTarget = keyProviderId
    ? safeRegistry.getConfigured().find((p) => p.id === keyProviderId)
    : safeRegistry.getDefault();

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {messages.length === 0 && !isRunning && !pickerMode && (
          <Text color={theme.muted}>
            Welcome! Type a message and press Enter. Shift+Enter for new line. Esc to quit.
          </Text>
        )}
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          streamingReasoning={streamingReasoning}
          streamingTools={streamingTools}
        />
        {pickerMode === "model" && (
          <ModelPicker
            registry={safeRegistry}
            current={agent.model}
            recent={userConfig.getRecentModels()}
            onSelect={handleModelSelect}
            onCancel={() => setPickerMode(null)}
          />
        )}
        {pickerMode === "provider" && (
          <ProviderPicker
            providers={safeRegistry.getConfigured().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled }))}
            current={currentProviderId}
            onSelect={handleProviderSelect}
            onCancel={() => setPickerMode(null)}
          />
        )}
        {pickerMode === "key" && keyTarget && (
          <KeyPicker
            providerName={keyTarget.name}
            onSubmit={handleKeySubmit}
            onCancel={() => {
              setPickerMode(null);
              setKeyProviderId(null);
            }}
          />
        )}
      </Box>
      <Box paddingX={1} paddingBottom={1} flexShrink={0}>
        <InputBox onSubmit={handleSubmit} disabled={isRunning || !!pickerMode} />
      </Box>
      {sessionManager && (
        <Box paddingX={1}>
          <Text color={theme.muted}>Session: {sessionManager.getSessionFile()}</Text>
        </Box>
      )}
    </Box>
  );
}
