/**
 * Per-message driver: takes a user prompt for a given scope, builds an
 * Agent, and streams its execution to a Feishu interactive card.
 *
 * Lifecycle:
 *   1. Resolve session (cwd + permissionMode) via SessionBinder
 *   2. Build PermissionAwareApprovalController (UI handler bound to scope)
 *   3. Construct tools + Agent for this run
 *   4. Open a streaming card via channel.stream(); inside its producer:
 *      a. iterate agent.run() events through the RunState reducer
 *      b. throttle/dispatch ctrl.update() with re-rendered card
 *   5. Handle abort, error, and idle-timeout terminal states
 */

import chalk from "chalk";
import { Agent } from "../../agent.js";
import { BudgetLedger } from "../../agent/budget-ledger.js";
import { PermissionAwareApprovalController } from "../../approval/controller.js";
import { BashAllowlist } from "../../approval/session-cache.js";
import type { ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import { getLspService } from "../../lsp/index.js";
import { ExternalHookController } from "../../hooks/index.js";
import { buildSystemPrompt } from "../../system-prompt.js";
import { FileStateTracker } from "../../tools/file-state.js";
import { buildToolPromptOptions, createAllTools, type PlanController } from "../../tools/index.js";
import { displayModel, encodeModel, decodeModel } from "../../provider-registry.js";
import { buildMemoryPrompt, recordMemoryCitations } from "../../memory/index.js";
import { getDefaultThinkingLevel } from "../../provider-transform.js";
import { createSessionTitleUpdater, type SessionTitleUpdater } from "../../session-title.js";
import type { AgentEvent, Message, PermissionMode, PlanDecision } from "../../types.js";
import type { SessionManager } from "../../session.js";
import { applyCardBudget } from "../card/budget.js";
import { renderCard } from "../card/renderer.js";
import { createInitialRunState, type RunState } from "../card/run-state-types.js";
import { hasInFlightTool, markError, markInterrupted, markIdleTimeout, reduceRunState } from "../card/run-state.js";
import type { BubbleChannel } from "../channel/channel.js";
import type { ScopeConfig } from "../types.js";
import type { ScopeKey } from "../types.js";
import type { FeishuRuntimeDeps } from "./runtime-deps.js";
import type { FeishuApprovalUI } from "./approval-ui.js";
import type { SessionBinder } from "../scope/session-binder.js";

export interface RunDriverOptions {
  channel: BubbleChannel;
  deps: FeishuRuntimeDeps;
  binder: SessionBinder;
  approvalUI: FeishuApprovalUI;
  outputThrottleMs: number;
  idleTimeoutMinutes: number;
  maxBytesPerElement: number;
  maxBytesPerCard: number;
}

export interface RunRequest {
  scopeKey: ScopeKey;
  scope: ScopeConfig;
  chatId: string;
  userId: string;
  prompt: string;
  replyToMessageId?: string;
  abortSignal: AbortSignal;
}

export class RunDriver {
  constructor(private readonly opts: RunDriverOptions) {}

  /**
   * Execute one run for one message. Returns when the agent has finished
   * (or been aborted). Throws only on truly unexpected errors — typical
   * failures (agent error, abort) are reflected in the card.
   */
  async runOnce(req: RunRequest): Promise<void> {
    // 1. Resolve session
    const session = this.opts.binder.openOrBootstrap(
      req.scopeKey,
      req.scope.cwd,
      req.scope.defaultPermissionMode,
    );
    const hookController = new ExternalHookController({ cwd: session.cwd });

    // 2. Build approval controller wired to FeishuApprovalUI
    const bashAllowlist = new BashAllowlist();
    const approvalHandlerRef: { current?: (r: ApprovalRequest) => Promise<ApprovalDecision> } = {
      current: this.opts.approvalUI.makeHandler(req.chatId, req.userId),
    };
    let agentRef: Agent | undefined;
    const approvalController = new PermissionAwareApprovalController({
      getMode: () => agentRef?.mode ?? session.permissionMode,
      handlerRef: approvalHandlerRef,
      bashAllowlist,
      cwd: session.cwd,
      getRuleSet: () => this.opts.deps.settingsManager.getMerged().ruleSet,
      externalHooks: hookController,
    });

    // 3. Build tools + Agent
    const lspService = getLspService(session.cwd, this.opts.deps.settingsManager.getMerged().lsp);
    const fileStateTracker = new FileStateTracker(session.cwd);

    let agentForPlan: Agent | undefined;
    const planController: PlanController = {
      getMode: () => agentForPlan?.mode ?? session.permissionMode,
      requestApproval: async (_plan): Promise<PlanDecision> =>
        // Feishu v1: plan mode just reject — encourages agent to summarize first.
        ({ action: "reject", reason: "Plan approval over Feishu not implemented; use /mode default." }),
      setMode: (mode) => agentForPlan?.setMode(mode),
    };

    const todoStore = {
      getTodos: () => agentRef?.getTodos() ?? [],
      setTodos: (todos: Parameters<Agent["setTodos"]>[0]) => agentRef?.setTodos(todos),
    };

    const tools = createAllTools(session.cwd, this.opts.deps.skillRegistry, {
      todoStore,
      planController,
      approvalController,
      lspService,
      fileStateTracker,
      checkpoints: () => session.manager.getCheckpoints(),
      // questionController intentionally omitted — Feishu v1 doesn't surface
      // the question tool to the agent.
    });
    tools.push(...this.opts.deps.mcpManager.getToolEntries());

    const promptCacheKey = session.manager.getOrCreatePromptCacheKey();
    const { provider, providerId, model } = await this.resolveProvider(session, promptCacheKey);
    const skills = this.opts.deps.skillRegistry.summaries();
    const memoryPrompt = buildMemoryPrompt(session.cwd);
    const thinkingLevel = this.opts.deps.userConfig.getDefaultThinkingLevel()
      ?? getDefaultThinkingLevel(providerId, decodeModel(model).modelId);
    const initialMode = session.permissionMode;
    const systemPrompt = buildSystemPrompt({
      agentName: "Bubble",
      configuredProvider: providerId || "none",
      configuredModel: model ? displayModel(model) : "none",
      configuredModelId: model || "none",
      thinkingLevel,
      mode: initialMode,
      workingDir: session.cwd,
      ...buildToolPromptOptions(tools.filter((tool) => !tool.deferred)),
      memoryPrompt,
    });
    const budgetLedger = new BudgetLedger();
    let sessionTitleUpdater: SessionTitleUpdater | undefined;
    const agent = new Agent({
      provider,
      providerId,
      model,
      sessionID: session.manager.getSessionFile(),
      tools,
      systemPrompt,
      temperature: 0.2,
      thinkingLevel,
      mode: initialMode,
      todos: session.manager.getTodos(),
      onMessageAppend: (message: Message) => {
        if (message.role === "system" || message.role === "meta") return;
        session.manager.appendMessage(message);
        sessionTitleUpdater?.handlePersistedMessage(message);
        if (message.role === "assistant") {
          recordMemoryCitations(session.cwd, message.content);
        }
      },
      onToolResult: (toolName, result) => {
        if (toolName !== "skill" || result.isError) return;
        const match = result.content.match(/^Skill:\s+([^\n]+)$/m);
        if (match?.[1]) session.manager.appendMarker("skill_activated", match[1].trim());
      },
      onTodosUpdate: (todos) => session.manager.appendTodosSnapshot(todos),
      onModeUpdate: (mode: PermissionMode) => {
        session.manager.appendMarker("mode_switch", mode);
        this.opts.binder.setMode(req.scopeKey, mode);
      },
      budgetLedger,
      skills,
      memoryPrompt,
      fileStateTracker,
      agentCategories: this.opts.deps.userConfig.getAgentCategories(),
      subagents: this.opts.deps.userConfig.getSubagents(),
      providerFactory: (route) => this.opts.deps.createProviderForRoute(route, promptCacheKey),
      externalHooks: hookController,
    });
    sessionTitleUpdater = createSessionTitleUpdater({
      sessionManager: session.manager,
      complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
    });
    agentRef = agent;
    agentForPlan = agent;
    session.manager.updateMetadata({
      ...(agent.model ? { model: agent.model } : {}),
      cwd: session.cwd,
      thinkingLevel: agent.thinking,
      reasoningEffort: agent.thinking,
    });
    await hookController.runEvent({
      eventName: "SessionStart",
      cwd: session.cwd,
      sessionId: session.manager.getSessionFile(),
      agentRole: "driver",
      target: "feishu",
      payload: {
        chatId: req.chatId,
        providerId,
        model,
      },
    });

    // Restore prior history into the running Agent instance.
    if (!session.fresh) {
      const history = session.manager.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: "system", content: systemPrompt }, ...history];
        if (agent.mode === "plan") agent.injectModeReminder();
      }
    }

    // 4. Build RunState + stream the card.
    const runState = createInitialRunState({
      scope: {
        chatId: req.chatId,
        userId: req.userId,
        displayName: req.scope.displayName,
        cwd: session.cwd,
      },
      mode: initialMode,
    });
    const runToken = `run_${Date.now().toString(36)}`;
    const budgetOpts = {
      maxBytesPerElement: this.opts.maxBytesPerElement,
      maxBytesPerCard: this.opts.maxBytesPerCard,
    };
    const collapsible = process.env.BUBBLE_FEISHU_NO_COLLAPSIBLE !== "1";
    const renderOpts = { budget: budgetOpts, runToken, collapsible };

    const initialCard = renderCard(runState, renderOpts);

    // Idle watchdog: aborts the run if no progress AND no in-flight tool
    // for idleTimeoutMinutes.
    const idleAbort = new AbortController();
    const idleMs = this.opts.idleTimeoutMinutes * 60 * 1000;
    let lastProgressAt = Date.now();
    const watchdog = setInterval(() => {
      if (req.abortSignal.aborted) return;
      if (Date.now() - lastProgressAt < idleMs) return;
      if (hasInFlightTool(runState)) {
        lastProgressAt = Date.now();
        return;
      }
      idleAbort.abort();
    }, Math.min(idleMs / 4, 30_000));

    const combinedAbort = composeSignals([req.abortSignal, idleAbort.signal]);

    try {
      await this.opts.channel.stream(req.chatId, {
        card: {
          initial: initialCard,
          producer: async (ctrl) => {
            try {
              for await (const event of agent.run(req.prompt, session.cwd, { abortSignal: combinedAbort })) {
                lastProgressAt = Date.now();
                reduceRunState(runState, event);
                // Trip event-aware updates: for tool_end and agent_end we
                // push immediately; text_delta relies on SDK throttle.
                if (event.type === "tool_start" || event.type === "tool_end" || event.type === "agent_end") {
                  await ctrl.update(renderCard(runState, renderOpts));
                } else {
                  await ctrl.update(renderCard(runState, renderOpts));
                }
                if (combinedAbort.aborted) break;
              }
            } catch (err) {
              if (req.abortSignal.aborted) {
                markInterrupted(runState);
              } else if (idleAbort.signal.aborted) {
                markIdleTimeout(runState);
              } else {
                markError(runState, err as Error);
              }
            } finally {
              applyCardBudget(runState, budgetOpts);
              await ctrl.update(renderCard(runState, { ...renderOpts, showStopButton: false }));
            }
          },
        },
      }, req.replyToMessageId ? { replyTo: req.replyToMessageId } : undefined);
    } catch (err) {
      // Failed before producer started — surface a plain text fallback.
      try {
        await this.opts.channel.send(req.chatId, {
          text: `❌ Bubble run failed to start: ${(err as Error).message}`,
        });
      } catch {
        // If even text send failed, log to stderr.
        console.error(chalk.red(`[feishu] failed to send fallback: ${(err as Error).message}`));
      }
    } finally {
      clearInterval(watchdog);
      await hookController.runEvent({
        eventName: "SessionEnd",
        cwd: session.cwd,
        sessionId: session.manager.getSessionFile(),
        agentRole: "driver",
        target: "feishu",
        payload: {
          chatId: req.chatId,
          providerId: agent.providerId,
          model: agent.apiModel,
        },
      });
      // Cancel any pending approval prompts attached to this run.
      this.opts.approvalUI.cancelForChat(req.chatId, "Run ended");
    }
  }

  private async resolveProvider(session: { cwd: string }, promptCacheKey: string): Promise<{ provider: import("../../types.js").Provider; providerId: string; model: string }> {
    const registry = this.opts.deps.providerRegistry;
    const userConfig = this.opts.deps.userConfig;

    // Read session metadata for an explicit model preference, fall back to
    // user config, then provider default.
    const configuredModel = userConfig.getDefaultModel();
    const defaultProvider = registry.getDefault();
    const fallbackProviderId = defaultProvider?.id ?? "";

    const normalizedConfigured = configuredModel
      ? (configuredModel.includes(":")
          ? configuredModel
          : (fallbackProviderId ? encodeModel(fallbackProviderId, configuredModel) : ""))
      : "";
    const { providerId: effectiveProviderId, modelId: effectiveModelId } = normalizedConfigured
      ? decodeModel(normalizedConfigured)
      : { providerId: undefined, modelId: "" };
    const activeProviderId = effectiveProviderId || fallbackProviderId;
    if (registry.supportsOAuth(activeProviderId) && registry.getAuthStorage().has(activeProviderId)) {
      await registry.prepareProvider(activeProviderId);
    }
    const target = registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
    if (!target?.apiKey) {
      throw new Error(`No provider configured — set up one in terminal Bubble before /serve.`);
    }
    const activeModel = effectiveModelId
      ? encodeModel(activeProviderId, effectiveModelId)
      : "";
    const provider = this.opts.deps.createProvider(
      activeProviderId,
      target.apiKey,
      target.baseURL,
      promptCacheKey,
    );
    return { provider, providerId: activeProviderId, model: activeModel };
  }
}

function composeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return new AbortController().signal;
  if (valid.length === 1) return valid[0]!;
  const merged = new AbortController();
  const handler = () => merged.abort();
  for (const s of valid) {
    if (s.aborted) {
      merged.abort();
      break;
    }
    s.addEventListener("abort", handler, { once: true });
  }
  return merged.signal;
}

// Re-export for symmetry with other modules.
export type { AgentEvent };
