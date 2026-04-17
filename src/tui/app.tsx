import React, { useCallback, useEffect, useState } from "react";
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
import { BUILTIN_PROVIDERS, ProviderRegistry, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ThinkingLevel } from "../types.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../provider-transform.js";
import { projectMessages } from "../context/projector.js";
import { getContextBudget } from "../context/budget.js";
import { FooterBar, buildFooterData } from "./footer.js";
import { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";

interface AppProps {
  agent: Agent;
  args: CliArgs;
  sessionManager?: SessionManager;
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => Provider;
  registry?: ProviderRegistry;
  skillRegistry?: SkillRegistry;
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

export function App({ agent, args, sessionManager, createProvider, registry, skillRegistry }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => reconstructDisplayMessages(agent.messages));
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);
  const [usageTotals, setUsageTotals] = useState({ prompt: 0, completion: 0 });
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(agent.thinking);
  const [pickerMode, setPickerMode] = useState<"model" | "key" | "provider" | "provider-add" | "login" | "logout" | null>(null);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);

  const userConfig = new UserConfig();
  const safeRegistry = registry ?? new ProviderRegistry(userConfig);
  const safeSkillRegistry = skillRegistry ?? new SkillRegistry({
    cwd: args.cwd,
    skillPaths: userConfig.getSkillPaths(),
  });

  useInput((_input, key) => {
    if (key.tab && key.shift && !pickerMode) {
      const modelParts = agent.model.includes(":")
        ? agent.model.split(":")
        : [agent.providerId || safeRegistry.getDefault()?.id || "openai", agent.model];
      const providerId = modelParts[0];
      const modelId = modelParts.slice(1).join(":");
      const availableLevels = getAvailableThinkingLevels(providerId, modelId);
      const currentLevel = normalizeThinkingLevel(agent.thinking, availableLevels);
      const currentIndex = availableLevels.indexOf(currentLevel);
      const nextLevel = availableLevels[(currentIndex + 1) % availableLevels.length];
      agent.thinking = nextLevel;
      agent.setSystemPrompt(buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId,
        configuredModel: displayModel(agent.model),
        configuredModelId: agent.model,
        thinkingLevel: nextLevel,
        workingDir: args.cwd,
        skills: safeSkillRegistry?.summaries() ?? [],
      }));
      userConfig.setDefaultThinkingLevel(nextLevel);
      setThinkingLevel(nextLevel);
      sessionManager?.setMetadata({ model: agent.model, thinkingLevel: nextLevel, reasoningEffort: nextLevel });
      sessionManager?.appendMarker("thinking_level_switch", nextLevel);
      return;
    }

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

  const openPicker = useCallback((mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout", providerId?: string) => {
    if (mode === "key") {
      setKeyProviderId(providerId ?? null);
    }
    setPickerMode(mode);
  }, []);

  const handleModelSelect = useCallback((model: string) => {
    const run = async () => {
      agent.model = model;
      const decoded = model.includes(":")
        ? model.split(":")
        : [agent.providerId || safeRegistry.getDefault()?.id || "openai", model];
      const providerId = decoded[0];

      await safeRegistry.prepareProvider(providerId);
      const provider = safeRegistry.getConfigured().find((item) => item.id === providerId);
      if (!provider?.apiKey || !createProvider) {
        addMessage("error", `Provider ${providerId} is not configured or has no active credentials.`);
        setPickerMode(null);
        return;
      }

      const modelId = model.includes(":") ? model.split(":").slice(1).join(":") : model;
      agent.thinking = normalizeThinkingLevel(
        agent.thinking || getDefaultThinkingLevel(providerId, modelId),
        getAvailableThinkingLevels(providerId, modelId),
      );
      agent.setProvider(createProvider(providerId, provider.apiKey, provider.baseURL));
      agent.providerId = providerId;
      agent.setSystemPrompt(buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId,
        configuredModel: displayModel(model),
        configuredModelId: model,
        thinkingLevel: agent.thinking,
        workingDir: args.cwd,
        skills: safeSkillRegistry?.summaries() ?? [],
      }));
      userConfig.pushRecentModel(model);
      setThinkingLevel(agent.thinking);
      sessionManager?.setMetadata({ model, thinkingLevel: agent.thinking, reasoningEffort: agent.thinking });
      sessionManager?.appendMarker("model_switch", model);
      addMessage("assistant", `Model switched to ${displayModel(model)}.`);
      setPickerMode(null);
    };

    void run();
  }, [agent, addMessage, sessionManager, userConfig, safeRegistry, createProvider]);

  const handleProviderSelect = useCallback(async (providerId: string) => {
    await safeRegistry.prepareProvider(providerId);
    const configured = safeRegistry.getConfigured();
    const p = configured.find((x) => x.id === providerId);
    const builtin = BUILTIN_PROVIDERS.find((x) => x.id === providerId);
    if (!p && !builtin) {
      addMessage("error", `Provider ${providerId} not found.`);
      setPickerMode(null);
      return;
    }
    if (!p?.apiKey) {
      if (!p && builtin) {
        safeRegistry.addProvider(providerId, "");
      }
      safeRegistry.setDefault(providerId);
      setKeyProviderId(providerId);
      setPickerMode("key");
      return;
    }
    safeRegistry.setDefault(providerId);
    agent.setProvider(createProvider!(providerId, p.apiKey, p.baseURL));
    agent.providerId = providerId;
    addMessage("assistant", `Switched to provider ${p.name}. Use /model to pick a model.`);
    setPickerMode(null);
  }, [addMessage, agent, createProvider, safeRegistry]);

  const handleProviderAddSelect = useCallback((providerId: string) => {
    const ok = safeRegistry.addProvider(providerId, "");
    if (!ok) {
      addMessage("error", `Provider ${providerId} could not be added.`);
      setPickerMode(null);
      return;
    }
    safeRegistry.setDefault(providerId);
    setKeyProviderId(providerId);
    setPickerMode("key");
  }, [addMessage, safeRegistry]);

  const handleLoginProviderSelect = useCallback(async (providerId: string) => {
    setPickerMode(null);
    const command = `/login ${providerId}`;
      const { handled, result } = await slashRegistry.execute(command, {
        agent,
        addMessage,
        clearMessages,
        cwd: args.cwd,
        exit,
      sessionManager,
      createProvider: createProvider ?? ((() => {
        throw new Error("Provider creation not available");
      }) as any),
      openPicker,
      registry: safeRegistry,
      skillRegistry: safeSkillRegistry!,
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, createProvider, exit, openPicker, safeRegistry, sessionManager]);

  const handleLogoutProviderSelect = useCallback(async (providerId: string) => {
    setPickerMode(null);
    const command = `/logout ${providerId}`;
      const { handled, result } = await slashRegistry.execute(command, {
        agent,
        addMessage,
        clearMessages,
        cwd: args.cwd,
        exit,
      sessionManager,
      createProvider: createProvider ?? ((() => {
        throw new Error("Provider creation not available");
      }) as any),
      openPicker,
      registry: safeRegistry,
      skillRegistry: safeSkillRegistry!,
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, createProvider, exit, openPicker, safeRegistry, sessionManager]);

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
      agent.setProvider(createProvider(targetId, key, p.baseURL));
      agent.providerId = targetId;
    }
    addMessage("assistant", `API key updated for ${p?.name || targetId} to ${maskKey(key)}.`);
    setPickerMode(null);
    setKeyProviderId(null);
  }, [addMessage, agent, createProvider, keyProviderId, safeRegistry]);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      const runAgentInput = async (actualInput: string, displayInput: string = actualInput) => {
        const activeProviderId = agent.providerId || safeRegistry.getDefault()?.id;
        const hasActiveProvider = !!activeProviderId && safeRegistry.getEnabled().some((provider) => provider.id === activeProviderId);
        if (!hasActiveProvider) {
          addMessage("error", "No provider configured. Use /login for ChatGPT or /provider --add <id> before sending a prompt.");
          return;
        }
        if (!agent.model) {
          addMessage("error", "No model selected. Use /model after /login or provider setup.");
          return;
        }

        setMessages((prev) => [...prev, { role: "user", content: displayInput }]);
        setIsRunning(true);
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingTools([]);

        let assistantContent = "";
        let assistantReasoning = "";
        const toolCalls: DisplayToolCall[] = [];

        try {
          for await (const event of agent.run(actualInput, args.cwd)) {
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
                if (event.usage) {
                  setUsageTotals((totals) => ({
                    prompt: totals.prompt + event.usage!.promptTokens,
                    completion: totals.completion + event.usage!.completionTokens,
                  }));
                }
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
      };

      // Intercept slash commands
      if (input.startsWith("/")) {
        const skillInvocation = parseSkillInvocation(input, safeSkillRegistry);
        if (skillInvocation) {
          await runAgentInput(skillInvocation.actualPrompt, input);
          return;
        }

        const { handled, result } = await slashRegistry.execute(input, {
          agent,
          addMessage,
          clearMessages,
          cwd: args.cwd,
          exit,
          sessionManager,
          createProvider: createProvider ?? ((() => {
            throw new Error("Provider creation not available");
          }) as any),
          openPicker,
          registry: safeRegistry,
          skillRegistry: safeSkillRegistry!,
        });
        if (handled) {
          if (result) {
            addMessage("assistant", result);
          }
          return;
        }
      }
      await runAgentInput(input);
    },
    [agent, args.cwd, openPicker, createProvider, safeRegistry, safeSkillRegistry]
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
            providers={BUILTIN_PROVIDERS
              .filter((p) => isUserVisibleProvider(p.id))
              .map((p) => {
                const configured = safeRegistry.getConfigured().find((item) => item.id === p.id);
                const configuredLabel = configured?.apiKey ? "configured" : "needs key";
                return {
                  id: p.id,
                  name: `${p.name} [${configuredLabel}]`,
                  enabled: true,
                };
              })}
            current={currentProviderId}
            onSelect={handleProviderSelect}
            onCancel={() => setPickerMode(null)}
          />
        )}
        {pickerMode === "provider-add" && (
          <ProviderPicker
            providers={BUILTIN_PROVIDERS
              .filter((p) => isUserVisibleProvider(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleProviderAddSelect}
            onCancel={() => setPickerMode(null)}
            title="Add Provider"
          />
        )}
        {pickerMode === "login" && (
          <ProviderPicker
            providers={BUILTIN_PROVIDERS
              .filter((p) => isUserVisibleProvider(p.id) && safeRegistry.supportsOAuth(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleLoginProviderSelect}
            onCancel={() => setPickerMode(null)}
            title="Select Login Provider"
          />
        )}
        {pickerMode === "logout" && (
          <ProviderPicker
            providers={safeRegistry.getConfigured()
              .filter((p) => safeRegistry.getAuthStorage().has(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleLogoutProviderSelect}
            onCancel={() => setPickerMode(null)}
            title="Select Logout Provider"
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
      {isRunning && !pickerMode && (
        <Box paddingX={1} paddingBottom={1} flexShrink={0}>
          <WaitingIndicator tools={streamingTools} />
        </Box>
      )}
      <Box paddingX={1} paddingBottom={1} flexShrink={0}>
        <InputBox onSubmit={handleSubmit} disabled={isRunning || !!pickerMode} skillRegistry={safeSkillRegistry} />
      </Box>
      <FooterBar
        data={buildFooterData({
          cwd: args.cwd,
          providerId: agent.providerId || safeRegistry.getDefault()?.id || "unknown",
          model: displayModel(agent.model) || "no model",
          thinkingLevel,
          showThinking: getAvailableThinkingLevels(agent.providerId, agent.apiModel).length > 2,
          usageTotals,
          budget: getContextBudget(
            agent.providerId || safeRegistry.getDefault()?.id || "unknown",
            agent.apiModel,
            projectMessages(agent.messages, { mode: "pruned" }),
          ),
        })}
      />
    </Box>
  );
}

function WaitingIndicator({ tools }: { tools: DisplayToolCall[] }) {
  const frames = ["◦", "•", "◦"];
  const genericPhrases = [
    "mapping the workspace",
    "reading the room",
    "following the threads",
    "connecting the pieces",
    "sorting the context",
    "scanning the structure",
    "shaping the next step",
    "gathering signal",
    "checking the edges",
    "lining up the answer",
    "tracing the flow",
    "building the picture",
    "walking the graph",
    "collecting the clues",
    "framing the problem",
    "locating the source",
    "resolving the shape",
    "untangling the state",
    "comparing the paths",
    "narrowing the target",
    "tracking the changes",
    "reading the patterns",
    "weighing the options",
    "assembling the context",
    "following the signal",
    "checking the assumptions",
    "aligning the details",
    "testing the shape",
    "pulling the thread",
    "cleaning the edges",
    "refining the draft",
    "verifying the route",
    "making sense of it",
    "looking for leverage",
    "stitching the answer",
    "holding the thread",
    "distilling the noise",
    "finding the seam",
    "reading between the lines",
    "preparing the response",
  ];
  const [frameIndex, setFrameIndex] = useState(0);
  const [phrase, setPhrase] = useState(genericPhrases[0]);

  useEffect(() => {
    const activeTool = [...tools].reverse().find((tool) => !tool.result);
    if (!activeTool) return;

    const toolTargets: Record<string, string> = {
      read: "reading files",
      write: "writing changes",
      edit: "patching files",
      grep: "searching the codebase",
      ls: "listing directories",
      bash: "running commands",
      web_search: "searching the web",
      web_fetch: "fetching a page",
    };

    setPhrase(toolTargets[activeTool.name] || `running ${activeTool.name}`);
  }, [tools]);

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frames.length);
    }, 220);

    const phraseTimer = setInterval(() => {
      const activeTool = [...tools].reverse().find((tool) => !tool.result);
      if (activeTool) {
        const toolTargets: Record<string, string> = {
          read: "reading files",
          write: "writing changes",
          edit: "patching files",
          grep: "searching the codebase",
          ls: "listing directories",
          bash: "running commands",
          web_search: "searching the web",
          web_fetch: "fetching a page",
        };
        setPhrase(toolTargets[activeTool.name] || `running ${activeTool.name}`);
        return;
      }

      setPhrase((current) => {
        const candidates = genericPhrases.filter((item) => item !== current);
        return candidates[Math.floor(Math.random() * candidates.length)] || current;
      });
    }, 1100);

    return () => {
      clearInterval(frameTimer);
      clearInterval(phraseTimer);
    };
  }, [tools]);

  return (
    <Box>
      <Text color={theme.accent}>{frames[frameIndex]}</Text>
      <Text color={theme.muted}> {phrase}</Text>
    </Box>
  );
}
