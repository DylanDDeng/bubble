/*
 * AgentBridge — runs the Bubble agent core in the Electron main process and
 * translates between the core (Agent / SessionManager / ApprovalController) and
 * the renderer IPC contract. Mirrors the integration pattern of the Feishu host
 * (src/feishu/agent-host/run-driver.ts), with IPC in place of Feishu cards.
 *
 * Core is imported from the built dist of the parent package and kept external
 * by esbuild, so the TUI/FFI layer is never pulled in.
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { Agent } from '@bubblebrain-ai/bubble/dist/agent.js';
import { SessionManager } from '@bubblebrain-ai/bubble/dist/session.js';
import { PermissionAwareApprovalController } from '@bubblebrain-ai/bubble/dist/approval/controller.js';
import { BashAllowlist } from '@bubblebrain-ai/bubble/dist/approval/session-cache.js';
import { createAllTools, type PlanController } from '@bubblebrain-ai/bubble/dist/tools/index.js';
import { buildToolPromptOptions } from '@bubblebrain-ai/bubble/dist/tools/prompt-metadata.js';
import { buildSystemPrompt } from '@bubblebrain-ai/bubble/dist/system-prompt.js';
import { FileStateTracker } from '@bubblebrain-ai/bubble/dist/tools/file-state.js';
import { BudgetLedger } from '@bubblebrain-ai/bubble/dist/agent/budget-ledger.js';
import { UserConfig } from '@bubblebrain-ai/bubble/dist/config.js';
import {
  ProviderRegistry,
  encodeModel,
  decodeModel,
  displayModel,
} from '@bubblebrain-ai/bubble/dist/provider-registry.js';
import { createProviderInstance } from '@bubblebrain-ai/bubble/dist/provider.js';
import { getDefaultThinkingLevel } from '@bubblebrain-ai/bubble/dist/variant/variant-resolver.js';
import type { ApprovalRequest, ApprovalDecision } from '@bubblebrain-ai/bubble/dist/approval/types.js';
import type { Provider, PermissionMode, Message } from '@bubblebrain-ai/bubble/dist/types.js';

import type {
  AgentEventDTO,
  ApprovalRequestDTO,
  ClientEvent,
  ServerEvent,
  SessionSummaryDTO,
} from './ipc-types';

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

interface ActiveRun {
  sessionId: string;
  abort: AbortController;
}

export class AgentBridge {
  private readonly userConfig = new UserConfig();
  private readonly registry = new ProviderRegistry(this.userConfig);
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private activeRun: ActiveRun | null = null;
  private readonly defaultCwd = process.env.BUBBLE_CWD || os.homedir();

  constructor(private readonly send: (event: ServerEvent) => void) {}

  async handle(event: ClientEvent): Promise<void> {
    switch (event.type) {
      case 'session.list':
        return this.listSessions();
      case 'session.start':
        return this.start(event.payload.prompt, event.payload.cwd ?? this.defaultCwd);
      case 'session.continue':
        return this.continue(event.payload.sessionId, event.payload.prompt);
      case 'session.open':
        return this.listSessions(); // history replay TODO; for now just refresh list
      case 'session.stop':
        this.activeRun?.abort.abort();
        return;
      case 'permission.response': {
        const pending = this.pendingApprovals.get(event.payload.requestId);
        if (!pending) return;
        this.pendingApprovals.delete(event.payload.requestId);
        pending.resolve(this.toDecision(event.payload.action, event.payload.feedback));
        return;
      }
    }
  }

  // --- sessions --------------------------------------------------------------

  private listSessions(): void {
    const summaries = SessionManager.summarizeSessionsForCwd(this.defaultCwd);
    const sessions: SessionSummaryDTO[] = summaries.map((s) => ({
      id: s.name,
      title: s.title || s.firstUserMessage || '新对话',
      preview: s.preview,
      messageCount: s.messageCount,
      mtime: s.mtime,
    }));
    this.send({ type: 'session.list', payload: { sessions } });
  }

  private async start(prompt: string, cwd: string): Promise<void> {
    const session = SessionManager.create(cwd, `desktop-${Date.now().toString(36)}`);
    const sessionId = session.getSessionFile();
    this.send({
      type: 'session.started',
      payload: { sessionId, cwd, title: prompt.slice(0, 40) || '新对话' },
    });
    await this.runTurn(session, sessionId, cwd, prompt);
  }

  private async continue(sessionId: string, prompt: string): Promise<void> {
    const session = SessionManager.resume(this.defaultCwd, sessionId);
    if (!session) {
      this.send({ type: 'runner.error', payload: { sessionId, message: '会话不存在' } });
      return;
    }
    await this.runTurn(session, sessionId, session.getMetadata().cwd ?? this.defaultCwd, prompt);
  }

  // --- the turn --------------------------------------------------------------

  private async runTurn(
    session: SessionManager,
    sessionId: string,
    cwd: string,
    prompt: string,
  ): Promise<void> {
    const abort = new AbortController();
    this.activeRun = { sessionId, abort };
    this.send({ type: 'session.status', payload: { sessionId, status: 'running' } });

    try {
      let agentRef: Agent | undefined;

      const approvalController = new PermissionAwareApprovalController({
        getMode: () => agentRef?.mode ?? 'default',
        handlerRef: { current: (req) => this.requestApproval(sessionId, req) },
        bashAllowlist: new BashAllowlist(),
        cwd,
      });

      const fileStateTracker = new FileStateTracker(cwd);
      const planController: PlanController = {
        getMode: () => agentRef?.mode ?? 'default',
        requestApproval: async () => ({ action: 'reject', reason: 'Plan mode 暂未在 GUI 实现' }),
        setMode: (mode) => agentRef?.setMode(mode),
      };
      const todoStore = {
        getTodos: () => agentRef?.getTodos() ?? [],
        setTodos: (todos: Parameters<Agent['setTodos']>[0]) => agentRef?.setTodos(todos),
      };

      const tools = createAllTools(cwd, undefined, {
        approvalController,
        fileStateTracker,
        planController,
        todoStore,
        checkpoints: () => session.getCheckpoints(),
      });

      const promptCacheKey = session.getOrCreatePromptCacheKey();
      const { provider, providerId, model } = this.resolveProvider(promptCacheKey);
      const thinkingLevel =
        this.userConfig.getDefaultThinkingLevel() ??
        getDefaultThinkingLevel(providerId, decodeModel(model).modelId);

      const systemPrompt = buildSystemPrompt({
        agentName: 'Bubble',
        configuredProvider: providerId || 'none',
        configuredModel: model ? displayModel(model) : 'none',
        configuredModelId: model || 'none',
        thinkingLevel,
        mode: 'default',
        workingDir: cwd,
        ...buildToolPromptOptions(tools.filter((t) => !t.deferred)),
      });

      const agent = new Agent({
        provider,
        providerId,
        model,
        sessionID: session.getSessionFile(),
        tools,
        systemPrompt,
        temperature: 0.2,
        thinkingLevel,
        mode: 'default',
        todos: session.getTodos(),
        budgetLedger: new BudgetLedger(),
        fileStateTracker,
        onMessageAppend: (message: Message) => {
          if (message.role === 'system' || message.role === 'meta') return;
          session.appendMessage(message);
        },
        onTodosUpdate: (todos) => session.appendTodosSnapshot(todos),
        onModeUpdate: (mode: PermissionMode) => session.appendMarker('mode_switch', mode),
      });
      agentRef = agent;

      // Restore prior history into the running agent.
      const history = session.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: 'system', content: systemPrompt }, ...history];
      }

      for await (const event of agent.run(prompt, cwd, { abortSignal: abort.signal })) {
        this.send({
          type: 'agent.event',
          payload: { sessionId, event: event as unknown as AgentEventDTO },
        });
        if (abort.signal.aborted) break;
      }
      this.send({ type: 'session.status', payload: { sessionId, status: 'idle' } });
    } catch (err) {
      this.send({
        type: 'runner.error',
        payload: { sessionId, message: (err as Error).message },
      });
      this.send({ type: 'session.status', payload: { sessionId, status: 'error' } });
    } finally {
      // Cancel any approvals still pending for this run.
      for (const [id, pending] of this.pendingApprovals) {
        pending.resolve({ action: 'reject', feedback: 'Run ended' });
        this.pendingApprovals.delete(id);
      }
      this.activeRun = null;
    }
  }

  // --- approval bridge -------------------------------------------------------

  private requestApproval(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
      this.send({
        type: 'permission.request',
        payload: { sessionId, requestId, request: req as unknown as ApprovalRequestDTO },
      });
    });
  }

  private toDecision(action: 'approve' | 'reject' | 'always', feedback?: string): ApprovalDecision {
    if (action === 'reject') return { action: 'reject', feedback };
    // 'always' is treated as approve for this run (rule persistence is a TODO).
    return { action: 'approve', feedback };
  }

  // --- provider resolution (mirrors run-driver.resolveProvider) --------------

  private resolveProvider(promptCacheKey: string): {
    provider: Provider;
    providerId: string;
    model: string;
  } {
    const configuredModel = this.userConfig.getDefaultModel();
    const defaultProvider = this.registry.getDefault();
    const fallbackProviderId = defaultProvider?.id ?? '';

    const normalized = configuredModel
      ? configuredModel.includes(':')
        ? configuredModel
        : fallbackProviderId
          ? encodeModel(fallbackProviderId, configuredModel)
          : ''
      : '';
    const { providerId: effId, modelId: effModelId } = normalized
      ? decodeModel(normalized)
      : { providerId: undefined, modelId: '' };
    const activeProviderId = effId || fallbackProviderId;

    const target =
      this.registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
    if (!target?.apiKey) {
      throw new Error('未找到可用的 provider — 请先在终端版 Bubble 配置 API key');
    }
    const activeModel = effModelId ? encodeModel(activeProviderId, effModelId) : '';
    const provider = createProviderInstance({
      providerId: activeProviderId,
      apiKey: target.apiKey,
      baseURL: target.baseURL,
      promptCacheKey,
    });
    return { provider, providerId: activeProviderId, model: activeModel };
  }
}
