/*
 * AgentRunner — drives the Bubble agent core in the Electron main process and
 * speaks coworker's renderer contract (ClientEvent in, ServerEvent out).
 *
 * It maps Bubble's AgentEvent stream onto coworker's StreamMessage model:
 *   text_delta      -> stream_event content_block_delta (text_delta)  [live]
 *   reasoning_delta -> stream_event content_block_delta (thinking_delta)
 *   tool_start      -> assistant message (uuid) with text + tool_use blocks
 *   tool_end        -> user message with a tool_result block
 *   turn_end        -> finalize assistant message
 *   agent_end       -> session.status completed
 * Approvals bridge ApprovalController <-> permission.request/response.
 */
import os from 'node:os';
import { rmSync } from 'node:fs';
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
import { QuestionController } from '@bubblebrain-ai/bubble/dist/question/controller.js';
import { SkillRegistry } from '@bubblebrain-ai/bubble/dist/skills/registry.js';
import { GoalStore } from '@bubblebrain-ai/bubble/dist/goal/store.js';
import { McpManager } from '@bubblebrain-ai/bubble/dist/mcp/manager.js';
import { loadMcpConfig } from '@bubblebrain-ai/bubble/dist/mcp/config.js';
import { ExternalHookController } from '@bubblebrain-ai/bubble/dist/hooks/controller.js';
import { registry as slashRegistry } from '@bubblebrain-ai/bubble/dist/slash-commands/index.js';
import type { QuestionAnswer, QuestionRequest } from '@bubblebrain-ai/bubble/dist/question/types.js';
import type { SlashCommandContext } from '@bubblebrain-ai/bubble/dist/slash-commands/types.js';
import type { ApprovalRequest, ApprovalDecision } from '@bubblebrain-ai/bubble/dist/approval/types.js';
import type { Provider, PermissionMode, ThinkingLevel, Message } from '@bubblebrain-ai/bubble/dist/types.js';
import { permissionModeToBubble, reasoningToThinking } from './selection-map';

import type {
  ClientEvent,
  ServerEvent,
  StreamMessage,
  SessionInfo,
  PermissionRequestInput,
} from '../shared/types';
import { TurnMapper, type MapperAgentEvent } from './turn-mapper';

type Emit = (event: ServerEvent) => void;

interface RunCtx {
  sessionId: string;
  abort: AbortController;
}

interface AttachmentLike {
  id?: string;
  path?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  kind?: string;
}

interface TurnOpts {
  title?: string;
  model?: string;
  mode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  attachments?: AttachmentLike[];
}

interface SessionStartLike {
  prompt: string;
  cwd?: string;
  title?: string;
  model?: string;
  aegisPermissionMode?: string;
  aegisReasoningEffort?: string;
  attachments?: AttachmentLike[];
}

interface SessionContinueLike {
  sessionId: string;
  prompt: string;
  model?: string;
  aegisPermissionMode?: string;
  aegisReasoningEffort?: string;
  attachments?: AttachmentLike[];
}

// Bubble's user-facing slash commands, surfaced to the composer's "/" menu.
const BUBBLE_SLASH_COMMANDS = [
  'model', 'clear', 'rewind', 'todos', 'context', 'compact', 'plan',
  'permissions', 'mcp', 'lsp', 'memory', 'goal', 'stats', 'theme',
  'skills', 'session', 'provider', 'login', 'key', 'logout', 'hooks', 'help',
];

export class AgentRunner {
  private readonly userConfig = new UserConfig();
  private readonly registry = new ProviderRegistry(this.userConfig);
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly pendingQuestions = new Map<string, { controller: QuestionController; request: QuestionRequest }>();
  private readonly runs = new Map<string, RunCtx>();
  private readonly cwdBySession = new Map<string, string>();
  private readonly sessionIndex = new Map<string, { cwd: string; file: string }>();
  private readonly defaultCwd = process.env.BUBBLE_CWD || os.homedir();

  constructor(private readonly emit: Emit) {}

  async handle(event: ClientEvent): Promise<void> {
    switch (event.type) {
      case 'session.list':
        return this.emitSessionList();
      case 'session.start':
        return this.start(event.payload);
      case 'session.continue':
      case 'session.editLatestPrompt':
        return this.continue(event.payload);
      case 'session.history':
        return this.emitHistory(event.payload.sessionId);
      case 'session.stop':
        this.runs.get(event.payload.sessionId)?.abort.abort();
        return;
      case 'session.delete': {
        const sid = event.payload.sessionId;
        try {
          const resolved = this.resolveSession(sid);
          if (resolved) rmSync(resolved.manager.getSessionFile(), { force: true });
        } catch {
          // best-effort delete
        }
        this.cwdBySession.delete(sid);
        this.sessionIndex.delete(sid);
        this.emit({ type: 'session.deleted', payload: { sessionId: sid } });
        return;
      }
      case 'permission.response': {
        const tid = event.payload.toolUseId;
        // Route ask_user_question responses to the QuestionController.
        const q = this.pendingQuestions.get(tid);
        if (q) {
          this.pendingQuestions.delete(tid);
          if (event.payload.result.behavior === 'deny') {
            q.controller.reject(tid);
          } else {
            const answersMap = (event.payload.result.updatedInput?.answers ?? {}) as Record<string, string>;
            const mapped: QuestionAnswer[] = q.request.questions.map((qq) =>
              (answersMap[qq.question] ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            );
            q.controller.reply(tid, mapped);
          }
          return;
        }
        const resolve = this.pendingApprovals.get(tid);
        if (resolve) {
          this.pendingApprovals.delete(tid);
          const behavior = event.payload.result.behavior;
          resolve(
            behavior === 'allow'
              ? { action: 'approve' }
              : { action: 'reject', feedback: event.payload.result.message },
          );
        }
        return;
      }
      case 'mcp.get-config':
        this.emit({ type: 'mcp.config', payload: { servers: {} } });
        return;
      case 'skills.list':
        this.emit({
          type: 'skills.list',
          payload: { userRoot: '', userSkills: [], projectSkills: [] },
        });
        return;
      case 'folder.list':
        this.emit({ type: 'folder.list', payload: { folders: [] } });
        return;
      default:
        return;
    }
  }

  // --- sessions --------------------------------------------------------------

  /** List sessions across ALL cwds (so project sessions survive restart) and (re)build the id->{cwd,file} index. */
  private rebuildSessionIndex(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    this.sessionIndex.clear();
    try {
      for (const s of SessionManager.listAllSessions()) {
        const cwd = s.cwd ?? s.cwdLabel ?? this.defaultCwd;
        this.sessionIndex.set(s.name, { cwd, file: s.file });
        sessions.push({
          id: s.name,
          title: s.title || s.firstUserMessage || '新对话',
          status: 'idle',
          provider: 'aegis',
          cwd,
          createdAt: s.mtime,
          updatedAt: s.mtime,
        });
      }
    } catch {
      // ignore — empty list
    }
    return sessions;
  }

  private emitSessionList(): void {
    this.emit({ type: 'session.list', payload: { sessions: this.rebuildSessionIndex() } });
  }

  /** Resolve a session by IPC id to its SessionManager + cwd, surviving restarts and any cwd. */
  private resolveSession(sessionId: string): { manager: SessionManager; cwd: string } | undefined {
    const memCwd = this.cwdBySession.get(sessionId);
    if (memCwd) {
      const m = SessionManager.resume(memCwd, this.sessionFileName(sessionId));
      if (m) return { manager: m, cwd: memCwd };
    }
    if (this.sessionIndex.size === 0) this.rebuildSessionIndex();
    const entry = this.sessionIndex.get(sessionId);
    if (!entry) return undefined;
    this.cwdBySession.set(sessionId, entry.cwd);
    return { manager: new SessionManager(entry.file), cwd: entry.cwd };
  }

  /**
   * Real Bubble provider/model config for the composer's agent picker.
   * Maps every configured Bubble provider's API key so the picker shows real
   * models (no "Configure" CTA) — Bubble is configured via the terminal app.
   */
  getAegisConfig(): {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    providerApiKeys: Record<string, string>;
    model: string;
    temperature: number;
  } {
    const configured = this.registry.getConfigured().filter((p) => p.enabled && p.apiKey);
    const def = this.registry.getDefault();
    const providerApiKeys: Record<string, string> = {};
    for (const p of configured) providerApiKeys[p.id] = p.apiKey;
    return {
      providerId: def?.id ?? '',
      baseUrl: def?.baseURL ?? '',
      apiKey: def?.apiKey ?? '',
      providerApiKeys,
      model: this.userConfig.getDefaultModel() ?? '',
      temperature: 0,
    };
  }

  /** Real Bubble skills for the composer's skill menu (aegis-list-skills handler). */
  listSkills(): { skills: Array<{ name: string; description: string }> } {
    try {
      const reg = new SkillRegistry({ cwd: this.defaultCwd, skillPaths: this.userConfig.getSkillPaths() });
      return { skills: reg.summaries().map((s) => ({ name: s.name, description: s.description })) };
    } catch {
      return { skills: [] };
    }
  }

  private emitHistory(sessionId: string): void {
    try {
      const resolved = this.resolveSession(sessionId);
      const messages: StreamMessage[] = [];
      if (resolved) {
        for (const m of resolved.manager.getMessages()) {
          const mapped = this.coreMessageToStream(m);
          if (mapped) messages.push(mapped);
        }
      }
      this.emit({ type: 'session.history', payload: { sessionId, status: 'idle', messages } });
    } catch {
      this.emit({ type: 'session.history', payload: { sessionId, status: 'idle', messages: [] } });
    }
  }

  private optsFromPayload(p: {
    model?: string;
    aegisPermissionMode?: string;
    aegisReasoningEffort?: string;
    attachments?: AttachmentLike[];
  }): TurnOpts {
    return {
      model: p.model,
      mode: permissionModeToBubble(p.aegisPermissionMode),
      thinkingLevel: reasoningToThinking(p.aegisReasoningEffort),
      attachments: p.attachments,
    };
  }

  /** Append attached file paths so the agent can open them with its read tools. */
  private augmentPrompt(prompt: string, attachments?: AttachmentLike[]): string {
    if (!attachments || attachments.length === 0) return prompt;
    const list = attachments
      .filter((a) => a.path)
      .map((a) => `- ${a.name ?? a.path} (${a.path})`)
      .join('\n');
    if (!list) return prompt;
    return `${prompt}\n\n[用户附带了以下文件,可用读取工具打开]\n${list}`;
  }

  /**
   * IPC session ids are the bare session name (no .jsonl), matching
   * SessionSummary.name. SessionManager keys files by the full name, so we
   * append .jsonl whenever we create/resume. One id, used consistently.
   */
  private sessionFileName(sessionId: string): string {
    return sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`;
  }

  private async start(payload: SessionStartLike): Promise<void> {
    const cwd = payload.cwd || this.defaultCwd;
    // Generate the id ONCE and use it for create, IPC, and resume.
    const sessionId = `desktop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const session = SessionManager.create(cwd, this.sessionFileName(sessionId));
    this.cwdBySession.set(sessionId, cwd);
    await this.runTurn(session, sessionId, cwd, payload.prompt, {
      title: payload.title || payload.prompt.slice(0, 40),
      ...this.optsFromPayload(payload),
    });
  }

  private async continue(payload: SessionContinueLike): Promise<void> {
    const sessionId = payload.sessionId;
    const resolved = this.resolveSession(sessionId);
    if (!resolved) {
      this.emit({ type: 'runner.error', payload: { sessionId, message: '会话不存在' } });
      return;
    }
    const { manager: session, cwd } = resolved;
    if (payload.prompt.trim().startsWith('/')) {
      await this.handleSlashCommand(session, sessionId, cwd, payload.prompt.trim());
      return;
    }
    await this.runTurn(session, sessionId, cwd, payload.prompt, this.optsFromPayload(payload));
  }

  /**
   * Route a "/command" prompt through Bubble's SlashCommandRegistry and render
   * the textual output as a message. Unlocks /context /compact /stats /memory
   * /mcp /lsp /permissions /goal /hooks /rewind /help etc. in the GUI.
   */
  private async handleSlashCommand(
    session: SessionManager,
    sessionId: string,
    cwd: string,
    input: string,
  ): Promise<void> {
    this.emit({ type: 'session.status', payload: { sessionId, status: 'running', cwd, provider: 'aegis' } });
    this.emit({ type: 'stream.user_prompt', payload: { sessionId, prompt: input, createdAt: Date.now() } });
    try {
      const skillRegistry = new SkillRegistry({ cwd, skillPaths: this.userConfig.getSkillPaths() });
      const promptCacheKey = session.getOrCreatePromptCacheKey();
      const { provider, providerId, model } = this.resolveProvider(promptCacheKey);
      const hookController = new ExternalHookController({ cwd, sessionId });
      let agentRef: Agent | undefined;
      const approvalController = new PermissionAwareApprovalController({
        getMode: () => agentRef?.mode ?? 'default',
        handlerRef: { current: (req) => this.requestApproval(sessionId, req) },
        bashAllowlist: new BashAllowlist(),
        cwd,
        externalHooks: hookController,
      });
      const tools = createAllTools(cwd, skillRegistry, { approvalController });
      const systemPrompt = buildSystemPrompt({
        agentName: 'Bubble',
        configuredProvider: providerId || 'none',
        configuredModel: model ? displayModel(model) : 'none',
        configuredModelId: model || 'none',
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
        mode: 'default',
        todos: session.getTodos(),
        skills: skillRegistry.summaries(),
        externalHooks: hookController,
      });
      agentRef = agent;
      const history = session.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: 'system', content: systemPrompt }, ...history];
      }

      const emitMsg = (role: 'user' | 'assistant' | 'error', content: string) => {
        const msg: StreamMessage =
          role === 'user'
            ? { type: 'user_prompt', prompt: content }
            : {
                type: 'assistant',
                uuid: randomUUID(),
                message: { content: [{ type: 'text', text: role === 'error' ? `⚠️ ${content}` : content }] },
              };
        this.emit({ type: 'stream.message', payload: { sessionId, message: msg } });
      };

      const ctx: SlashCommandContext = {
        agent,
        addMessage: emitMsg,
        clearMessages: () =>
          this.emit({ type: 'session.history', payload: { sessionId, status: 'idle', messages: [] } }),
        cwd,
        exit: () => {},
        sessionManager: session,
        createProvider: (pid, key, baseURL) => createProviderInstance({ providerId: pid, apiKey: key, baseURL }),
        registry: this.registry,
        skillRegistry,
        hookController,
      };

      const res = await slashRegistry.execute(input, ctx);
      if (res.result) emitMsg('assistant', res.result);
      if (res.inject) {
        await this.runTurn(session, sessionId, cwd, res.inject, {});
        return;
      }
      this.emit({ type: 'session.status', payload: { sessionId, status: 'completed' } });
    } catch (err) {
      this.emit({ type: 'runner.error', payload: { sessionId, message: (err as Error).message } });
      this.emit({ type: 'session.status', payload: { sessionId, status: 'error', error: (err as Error).message } });
    }
  }

  // --- the turn --------------------------------------------------------------

  private async runTurn(
    session: SessionManager,
    sessionId: string,
    cwd: string,
    prompt: string,
    opts: TurnOpts = {},
  ): Promise<void> {
    const abort = new AbortController();
    this.runs.set(sessionId, { sessionId, abort });
    const mode: PermissionMode = opts.mode ?? 'default';

    let providerId = 'none';
    let model = '';
    try {
      let agentRef: Agent | undefined;
      const hookController = new ExternalHookController({ cwd, sessionId });
      const approvalController = new PermissionAwareApprovalController({
        getMode: () => agentRef?.mode ?? mode,
        handlerRef: { current: (req) => this.requestApproval(sessionId, req) },
        bashAllowlist: new BashAllowlist(),
        cwd,
        externalHooks: hookController,
      });
      const fileStateTracker = new FileStateTracker(cwd);
      const planController: PlanController = {
        getMode: () => agentRef?.mode ?? mode,
        requestApproval: async (plan) => {
          const md =
            typeof plan === 'string'
              ? plan
              : ((plan as { plan?: string; markdown?: string })?.plan ??
                (plan as { markdown?: string })?.markdown ??
                '');
          if (md) {
            this.emit({
              type: 'stream.message',
              payload: { sessionId, message: { type: 'proposed_plan', uuid: randomUUID(), planMarkdown: md } },
            });
          }
          const approved = await this.requestPlanApproval(sessionId);
          if (approved) {
            agentRef?.setMode('default');
            return { action: 'approve' };
          }
          return { action: 'reject', reason: '用户拒绝了该计划' };
        },
        setMode: (m) => agentRef?.setMode(m),
      };
      const todoStore = {
        getTodos: () => agentRef?.getTodos() ?? [],
        setTodos: (todos: Parameters<Agent['setTodos']>[0]) => agentRef?.setTodos(todos),
      };

      // Bubble's question tool -> coworker DecisionPanel via permission.request.
      const questionController = new QuestionController();
      questionController.subscribe((evt) => {
        if (evt.type !== 'asked') return;
        const req = evt.request;
        this.pendingQuestions.set(req.id, { controller: questionController, request: req });
        this.emit({
          type: 'permission.request',
          payload: {
            sessionId,
            toolUseId: req.id,
            toolName: 'question',
            input: {
              questions: req.questions.map((q) => ({
                question: q.question,
                header: q.header || undefined,
                multiSelect: q.multiple === true,
                options: q.options?.map((o) => ({ label: o.label, description: o.description || undefined })),
              })),
            },
          },
        });
      });

      const skillRegistry = new SkillRegistry({ cwd, skillPaths: this.userConfig.getSkillPaths() });
      const goalStore = new GoalStore();
      const tools = createAllTools(cwd, skillRegistry, {
        approvalController,
        fileStateTracker,
        planController,
        todoStore,
        questionController,
        goalStore,
        checkpoints: () => session.getCheckpoints(),
      });

      // MCP tools (best-effort; only when servers are configured in settings).
      try {
        const mcpLoaded = loadMcpConfig({ cwd });
        if (mcpLoaded.servers.length > 0) {
          const mcpManager = new McpManager({ servers: mcpLoaded.servers });
          await mcpManager.start();
          tools.push(...mcpManager.getToolEntries());
        }
      } catch (err) {
        console.error('[mcp] failed to start servers', err);
      }

      const promptCacheKey = session.getOrCreatePromptCacheKey();
      session.updateMetadata({ cwd }); // so the session is recoverable by cwd after restart
      const resolved = this.resolveProvider(promptCacheKey, opts.model);
      providerId = resolved.providerId;
      model = resolved.model;
      const thinkingLevel =
        opts.thinkingLevel ??
        this.userConfig.getDefaultThinkingLevel() ??
        getDefaultThinkingLevel(providerId, decodeModel(model).modelId);
      const systemPrompt = buildSystemPrompt({
        agentName: 'Bubble',
        configuredProvider: providerId || 'none',
        configuredModel: model ? displayModel(model) : 'none',
        configuredModelId: model || 'none',
        thinkingLevel,
        mode,
        workingDir: cwd,
        ...buildToolPromptOptions(tools.filter((t) => !t.deferred)),
      });

      // Session is created/updated in the renderer store via session.status.
      this.emit({
        type: 'session.status',
        payload: { sessionId, status: 'running', title: opts.title, cwd, provider: 'aegis', model: model || undefined },
      });
      // system init: surfaces Bubble's tools, skills, and slash commands to the UI.
      this.emit({
        type: 'stream.message',
        payload: {
          sessionId,
          message: {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            model: model || 'bubble',
            permissionMode: mode,
            cwd,
            tools: tools
              .map((t) => (t as { definition?: { name?: string }; name?: string }).definition?.name ?? (t as { name?: string }).name)
              .filter((n): n is string => Boolean(n)),
            slash_commands: BUBBLE_SLASH_COMMANDS,
            skills: skillRegistry.summaries().map((s) => s.name),
          },
        },
      });
      this.emit({
        type: 'stream.user_prompt',
        payload: { sessionId, prompt, attachments: opts.attachments as never, createdAt: Date.now() },
      });

      const agent = new Agent({
        provider: resolved.provider,
        providerId,
        model,
        sessionID: session.getSessionFile(),
        tools,
        systemPrompt,
        temperature: 0.2,
        thinkingLevel,
        mode,
        todos: session.getTodos(),
        budgetLedger: new BudgetLedger(),
        fileStateTracker,
        skills: skillRegistry.summaries(),
        externalHooks: hookController,
        onMessageAppend: (message: Message) => {
          if (message.role === 'system' || message.role === 'meta') return;
          session.appendMessage(message);
        },
        onTodosUpdate: (todos) => session.appendTodosSnapshot(todos),
        onModeUpdate: (mode: PermissionMode) => session.appendMarker('mode_switch', mode),
      });
      agentRef = agent;

      const history = session.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: 'system', content: systemPrompt }, ...history];
      }

      await this.streamAgent(agent, sessionId, cwd, this.augmentPrompt(prompt, opts.attachments), abort.signal);
      this.emit({ type: 'session.status', payload: { sessionId, status: 'completed' } });
    } catch (err) {
      this.emit({ type: 'runner.error', payload: { sessionId, message: (err as Error).message } });
      this.emit({ type: 'session.status', payload: { sessionId, status: 'error', error: (err as Error).message } });
    } finally {
      for (const [id, resolve] of this.pendingApprovals) {
        resolve({ action: 'reject', feedback: 'Run ended' });
        this.pendingApprovals.delete(id);
      }
      for (const [id, q] of this.pendingQuestions) {
        q.controller.reject(id);
        this.pendingQuestions.delete(id);
      }
      this.runs.delete(sessionId);
    }
  }

  /** Map the Bubble AgentEvent stream to coworker StreamMessage emissions. */
  private async streamAgent(
    agent: Agent,
    sessionId: string,
    cwd: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const mapper = new TurnMapper(sessionId, this.emit);
    for await (const event of agent.run(prompt, cwd, { abortSignal: signal })) {
      mapper.handle(event as unknown as MapperAgentEvent);
      if (signal.aborted) break;
    }
    mapper.finish();
  }

  private coreMessageToStream(m: Message): StreamMessage | null {
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '';
      return { type: 'user_prompt', prompt: text };
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      return { type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text }] } };
    }
    return null;
  }

  // --- approval bridge -------------------------------------------------------

  private requestApproval(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const toolUseId = randomUUID();
    const input = this.approvalToInput(req);
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(toolUseId, resolve);
      this.emit({
        type: 'permission.request',
        payload: { sessionId, toolUseId, toolName: req.type, input },
      });
    });
  }

  /** Plan-mode proposal approval: returns true if the user approved executing the plan. */
  private requestPlanApproval(sessionId: string): Promise<boolean> {
    const toolUseId = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(toolUseId, (d) => resolve(d.action === 'approve'));
      this.emit({
        type: 'permission.request',
        payload: {
          sessionId,
          toolUseId,
          toolName: 'exit_plan_mode',
          input: {
            kind: 'codex-approval',
            approvalKind: 'permissions',
            method: '',
            question: '批准并开始执行这个计划吗?',
            title: '执行计划',
            toolName: 'exit_plan_mode',
            canAllowForSession: false,
          },
        },
      });
    });
  }

  private approvalToInput(req: ApprovalRequest): PermissionRequestInput {
    switch (req.type) {
      case 'bash':
        return {
          kind: 'codex-approval',
          approvalKind: 'command',
          method: '',
          question: '允许运行这条命令吗?',
          title: '运行命令',
          toolName: 'bash',
          command: req.command,
          cwd: req.cwd,
          canAllowForSession: true,
        };
      case 'edit':
      case 'write':
        return {
          kind: 'codex-approval',
          approvalKind: 'file-change',
          method: '',
          question: req.type === 'write' ? '允许写入这个文件吗?' : '允许修改这个文件吗?',
          title: req.type === 'write' ? '写入文件' : '编辑文件',
          toolName: req.type,
          filePath: req.path,
          canAllowForSession: true,
        };
      case 'patch':
        return {
          kind: 'codex-approval',
          approvalKind: 'file-change',
          method: '',
          question: '允许应用这些改动吗?',
          title: '批量改动',
          toolName: 'patch',
          files: req.paths,
          canAllowForSession: true,
        };
      default:
        return {
          kind: 'codex-approval',
          approvalKind: 'tool',
          method: '',
          question: '允许这个操作吗?',
          title: '需要许可',
          toolName: req.type,
          canAllowForSession: true,
        };
    }
  }

  // --- provider resolution (mirrors feishu run-driver) -----------------------

  private resolveProvider(
    promptCacheKey: string,
    explicitModel?: string,
  ): {
    provider: Provider;
    providerId: string;
    model: string;
  } {
    // Composer model selection (if any) overrides the user's default model.
    const configuredModel = explicitModel || this.userConfig.getDefaultModel();
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
