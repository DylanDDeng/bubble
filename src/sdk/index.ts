/**
 * Bubble SDK — the programmatic embedding surface for external hosts.
 *
 * Two layers:
 *  1. `BubbleSdk` — a high-level facade that owns config/provider resolution and
 *     assembles a full agent turn (tools, approvals, questions, plan mode, MCP,
 *     skills, hooks, session persistence) behind a single `runTurn()` async
 *     iterator of `AgentEvent`s. This is what a host like an Electron app should
 *     consume: wire the three interaction callbacks (approval / question / plan)
 *     to its own UI and map the event stream to its own message format.
 *  2. Curated re-exports of the underlying building blocks, for hosts that need
 *     to assemble a custom loop the facade doesn't cover.
 *
 * Runs under plain Node (>=20); nothing here touches the TUI layer.
 */

import os from "node:os";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { Agent } from "../agent.js";
import { SessionManager, type SessionSummary } from "../session.js";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import { BashAllowlist } from "../approval/session-cache.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import { createAllTools, buildToolPromptOptions, type PlanController } from "../tools/index.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { FileStateTracker } from "../tools/file-state.js";
import { BudgetLedger } from "../agent/budget-ledger.js";
import { UserConfig } from "../config.js";
import { ProviderRegistry, encodeModel, decodeModel, displayModel } from "../provider-registry.js";
import { createProviderInstance } from "../provider.js";
import { getDefaultThinkingLevel } from "../variant/variant-resolver.js";
import { QuestionController, type QuestionAnswer, type QuestionRequest } from "../question/controller.js";
import { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import type { SkillSummary } from "../skills/types.js";
import { GoalStore } from "../goal/store.js";
import { McpManager } from "../mcp/manager.js";
import { loadMcpConfig } from "../mcp/config.js";
import { ExternalHookController } from "../hooks/controller.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { calculateUsageCost } from "../model-pricing.js";
import { purgeUnsafeMemorySources } from "../memory/session-policy.js";
import { recordMemoryCitations } from "../memory/usage.js";
import type {
  AgentEvent,
  ContentPart,
  Message,
  PermissionMode,
  Provider,
  ThinkingLevel,
  ToolRegistryEntry,
} from "../types.js";

// ── Facade types ───────────────────────────────────────────────────────────

export interface BubbleSdkOptions {
  /** Fallback working directory for sessions created without an explicit cwd. */
  defaultCwd?: string;
}

/** Resolved turn configuration, reported via onStart (e.g. for a host's system-init event). */
export interface TurnStartInfo {
  providerId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  mode: PermissionMode;
  tools: string[];
  skills: string[];
}

/** Host-side interaction callbacks for one turn. All optional; missing handlers fail safe (reject). */
export interface TurnHandlers {
  /**
   * Tool call needs user permission (bash / edit / write / …). When the turn is
   * aborted, any still-pending request auto-resolves to reject — the host's
   * promise may settle later and is then ignored.
   */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Agent asked the user a structured question. Return answers, or null to decline. */
  onQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer[] | null>;
  /** Plan-mode proposal. Return true to approve executing the plan. */
  onPlanApproval?: (planMarkdown: string) => Promise<boolean>;
  /** Fired once per turn after provider/model/tools are resolved, before the first event. */
  onStart?: (info: TurnStartInfo) => void;
}

export interface RunTurnOptions extends TurnHandlers {
  /** Plain text, or content parts (text + base64 images) for attachments. */
  prompt: string | ContentPart[];
  /** "provider:model" or bare model id (resolved against the default provider). */
  model?: string;
  mode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export interface SdkSessionRef {
  id: string;
  cwd: string;
}

// ── Facade ─────────────────────────────────────────────────────────────────

export class BubbleSdk {
  readonly userConfig = new UserConfig();
  readonly registry = new ProviderRegistry(this.userConfig);

  private readonly defaultCwd: string;
  private readonly cwdBySession = new Map<string, string>();
  private readonly bashAllowlists = new Map<string, BashAllowlist>();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly mcpToolsByCwd = new Map<string, Promise<ToolRegistryEntry[]>>();
  /** id -> {cwd,file} rebuilt from disk so sessions survive host restarts. */
  private sessionIndex = new Map<string, { cwd: string; file: string }>();

  constructor(options: BubbleSdkOptions = {}) {
    this.defaultCwd = options.defaultCwd || process.env.BUBBLE_CWD || os.homedir();
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  listSessions(): SessionSummary[] {
    const sessions = SessionManager.listAllSessions();
    this.sessionIndex = new Map(
      sessions.map((s) => [s.name, { cwd: s.cwd ?? s.cwdLabel ?? this.defaultCwd, file: s.file }]),
    );
    return sessions;
  }

  createSession(options: { cwd?: string; id?: string } = {}): SdkSessionRef {
    const cwd = options.cwd || this.defaultCwd;
    const id = options.id || `sdk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    SessionManager.create(cwd, sessionFileName(id));
    this.cwdBySession.set(id, cwd);
    return { id, cwd };
  }

  getHistory(sessionId: string): Message[] {
    return this.resolveSession(sessionId)?.manager.getMessages() ?? [];
  }

  deleteSession(sessionId: string): void {
    const resolved = this.resolveSession(sessionId);
    if (resolved) rmSync(resolved.manager.getSessionFile(), { force: true });
    this.cwdBySession.delete(sessionId);
    this.bashAllowlists.delete(sessionId);
    this.sessionIndex.delete(sessionId);
  }

  /** Abort the in-flight turn of a session, if any. */
  stop(sessionId: string): void {
    this.activeTurns.get(sessionId)?.abort();
  }

  // ── Discovery (composer pickers) ─────────────────────────────────────────

  listSkills(cwd?: string): SkillSummary[] {
    const registry = new SkillRegistry({
      cwd: cwd || this.defaultCwd,
      skillPaths: this.userConfig.getSkillPaths(),
    });
    return registry.summaries();
  }

  /** Configured providers + default model, for a host's model picker. */
  getModelConfig(): {
    defaultProviderId: string;
    defaultModel: string;
    providers: Array<{ id: string; baseURL?: string; hasApiKey: boolean }>;
  } {
    const configured = this.registry.getConfigured().filter((p) => p.enabled);
    return {
      defaultProviderId: this.registry.getDefault()?.id ?? "",
      defaultModel: this.userConfig.getDefaultModel() ?? "",
      providers: configured.map((p) => ({ id: p.id, baseURL: p.baseURL, hasApiKey: Boolean(p.apiKey) })),
    };
  }

  // ── The turn ─────────────────────────────────────────────────────────────

  async *runTurn(sessionId: string, options: RunTurnOptions): AsyncGenerator<AgentEvent> {
    const resolved = this.resolveSession(sessionId);
    if (!resolved) throw new Error(`Unknown session: ${sessionId}`);
    const { manager: session, cwd } = resolved;
    const mode: PermissionMode = options.mode ?? "default";

    const abort = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) abort.abort();
      else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    this.activeTurns.set(sessionId, abort);

    let agentRef: Agent | undefined;
    const hookController = new ExternalHookController({ cwd, sessionId });
    // Settles as reject the moment the turn aborts, so a tool blocked on a
    // host approval (or question) can never hang the abort path.
    const abortedDecision = new Promise<ApprovalDecision>((resolve) => {
      const decide = () => resolve({ action: "reject", feedback: "Turn aborted" });
      if (abort.signal.aborted) decide();
      else abort.signal.addEventListener("abort", decide, { once: true });
    });
    const approvalController = new PermissionAwareApprovalController({
      getMode: () => agentRef?.mode ?? mode,
      handlerRef: {
        current: (req: ApprovalRequest) =>
          options.onApproval
            ? Promise.race([options.onApproval(req), abortedDecision])
            : Promise.resolve<ApprovalDecision>({
                action: "reject",
                feedback: "Host provided no approval handler",
              }),
      },
      bashAllowlist: this.bashAllowlistFor(sessionId),
      cwd,
      externalHooks: hookController,
    });
    const fileStateTracker = new FileStateTracker(cwd);
    const planController: PlanController = {
      getMode: () => agentRef?.mode ?? mode,
      requestApproval: async (plan: string) => {
        const approved = options.onPlanApproval ? await options.onPlanApproval(plan) : false;
        if (approved) {
          agentRef?.setMode("default");
          return { action: "approve" as const, plan };
        }
        return { action: "reject" as const, reason: "Plan rejected by host" };
      },
      setMode: (m) => agentRef?.setMode(m),
    };
    const questionController = new QuestionController();
    const unsubscribeQuestions = questionController.subscribe((event) => {
      if (event.type !== "asked") return;
      const request = event.request;
      if (!options.onQuestion) {
        questionController.reject(request.id);
        return;
      }
      options.onQuestion(request).then(
        (answers) =>
          answers ? questionController.reply(request.id, answers) : questionController.reject(request.id),
        () => questionController.reject(request.id),
      );
    });
    abort.signal.addEventListener("abort", () => questionController.rejectAll(), { once: true });

    try {
      const skillRegistry = new SkillRegistry({ cwd, skillPaths: this.userConfig.getSkillPaths() });
      const tools = createAllTools(cwd, skillRegistry, {
        approvalController,
        fileStateTracker,
        planController,
        todoStore: {
          getTodos: () => agentRef?.getTodos() ?? [],
          setTodos: (todos) => agentRef?.setTodos(todos),
        },
        questionController,
        goalStore: new GoalStore(),
        checkpoints: () => session.getCheckpoints(),
      });
      tools.push(...(await this.mcpToolsFor(cwd)));

      const promptCacheKey = session.getOrCreatePromptCacheKey();
      session.updateMetadata({ cwd }); // recoverable by cwd after host restart
      const { provider, providerId, model } = this.resolveProvider(promptCacheKey, options.model);
      const thinkingLevel =
        options.thinkingLevel ??
        this.userConfig.getDefaultThinkingLevel() ??
        getDefaultThinkingLevel(providerId, decodeModel(model).modelId);
      // Same ordering as the TUI: the provenance gate must run before memories
      // enter the system prompt.
      purgeUnsafeMemorySources(cwd);
      const memoryPrompt = buildMemoryPrompt(cwd);
      const systemPrompt = buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId || "none",
        configuredModel: model ? displayModel(model) : "none",
        configuredModelId: model || "none",
        thinkingLevel,
        mode,
        workingDir: cwd,
        ...buildToolPromptOptions(tools.filter((t) => !t.deferred)),
        memoryPrompt,
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
        mode,
        todos: session.getTodos(),
        budgetLedger: new BudgetLedger(),
        fileStateTracker,
        skills: skillRegistry.summaries(),
        memoryPrompt,
        externalHooks: hookController,
        onMessageAppend: (message: Message) => {
          if (message.role === "system" || message.role === "meta") return;
          session.appendMessage(message);
          if (message.role === "assistant") recordMemoryCitations(cwd, message.content);
        },
        onTodosUpdate: (todos) => session.appendTodosSnapshot(todos),
        onModeUpdate: (m: PermissionMode) => session.appendMarker("mode_switch", m),
      });
      agentRef = agent;

      const history = session.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: "system", content: systemPrompt }, ...history];
      }

      options.onStart?.({
        providerId,
        model,
        thinkingLevel,
        mode,
        tools: tools.map((t) => t.name),
        skills: skillRegistry.summaries().map((s) => s.name),
      });

      // Match the TUI: a leading "/<skill-name> <task>" becomes an explicit
      // load-this-skill instruction, so invocation never depends on the model
      // recognizing the slash syntax on its own.
      const prompt = rewriteSkillInvocationPrompt(options.prompt, skillRegistry);

      const bareModelId = decodeModel(model).modelId;
      for await (const event of agent.run(prompt, cwd, { abortSignal: abort.signal })) {
        yield attachTurnCost(event, providerId, bareModelId);
        if (abort.signal.aborted) break;
      }
    } finally {
      // Also reached via generator.return() when the host stops consuming
      // early: aborting here unblocks any tool still awaiting an approval.
      abort.abort();
      unsubscribeQuestions();
      questionController.rejectAll();
      if (this.activeTurns.get(sessionId) === abort) this.activeTurns.delete(sessionId);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private bashAllowlistFor(sessionId: string): BashAllowlist {
    let allowlist = this.bashAllowlists.get(sessionId);
    if (!allowlist) {
      allowlist = new BashAllowlist();
      this.bashAllowlists.set(sessionId, allowlist);
    }
    return allowlist;
  }

  /** MCP servers are started lazily, once per cwd (McpManager has no stop). */
  private mcpToolsFor(cwd: string): Promise<ToolRegistryEntry[]> {
    let cached = this.mcpToolsByCwd.get(cwd);
    if (!cached) {
      cached = (async () => {
        const loaded = loadMcpConfig({ cwd });
        if (loaded.servers.length === 0) return [];
        const manager = new McpManager({ servers: loaded.servers });
        await manager.start();
        return manager.getToolEntries();
      })().catch(() => []);
      this.mcpToolsByCwd.set(cwd, cached);
    }
    return cached;
  }

  private resolveSession(sessionId: string): { manager: SessionManager; cwd: string } | undefined {
    const memCwd = this.cwdBySession.get(sessionId);
    if (memCwd) {
      // create() only resolves the path and loads iff the file exists, so this
      // covers both fresh (lazily persisted, not yet on disk) and resumed sessions.
      return { manager: SessionManager.create(memCwd, sessionFileName(sessionId)), cwd: memCwd };
    }
    if (this.sessionIndex.size === 0) this.listSessions();
    const entry = this.sessionIndex.get(sessionId);
    if (!entry) return undefined;
    this.cwdBySession.set(sessionId, entry.cwd);
    return { manager: new SessionManager(entry.file), cwd: entry.cwd };
  }

  private resolveProvider(
    promptCacheKey: string,
    explicitModel?: string,
  ): { provider: Provider; providerId: string; model: string } {
    const configuredModel = explicitModel || this.userConfig.getDefaultModel();
    const defaultProvider = this.registry.getDefault();
    const fallbackProviderId = defaultProvider?.id ?? "";
    const normalized = configuredModel
      ? configuredModel.includes(":")
        ? configuredModel
        : fallbackProviderId
          ? encodeModel(fallbackProviderId, configuredModel)
          : ""
      : "";
    const { providerId: effId, modelId: effModelId } = normalized
      ? decodeModel(normalized)
      : { providerId: undefined, modelId: "" };
    const activeProviderId = effId || fallbackProviderId;
    const target =
      this.registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
    if (!target?.apiKey) {
      throw new Error("No provider with an API key configured — run the Bubble CLI once to set one up");
    }
    const activeModel = effModelId ? encodeModel(activeProviderId, effModelId) : "";
    const provider = createProviderInstance({
      providerId: activeProviderId,
      apiKey: target.apiKey,
      baseURL: target.baseURL,
      promptCacheKey,
    });
    return { provider, providerId: activeProviderId, model: activeModel };
  }
}

function sessionFileName(sessionId: string): string {
  return sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
}

/**
 * Attach a `cost` field to turn_end events that carry usage, priced via the
 * static pricing table. Pricing is an accounting concern, so it rides along
 * here in the SDK rather than in the agent core. Multi-step turns emit several
 * turn_end events; each cost covers only that step's usage, so hosts sum them.
 * Events for unpriced models (or without usage) pass through untouched.
 */
export function attachTurnCost(event: AgentEvent, providerId: string, modelId: string): AgentEvent {
  if (event.type !== "turn_end" || !event.usage) return event;
  const cost = calculateUsageCost(providerId, modelId, event.usage);
  return cost ? { ...event, cost } : event;
}

/**
 * If the prompt (or its first text part) is a "/<skill-name> <task>" skill
 * invocation, rewrite it into the same explicit execution prompt the TUI
 * sends. Non-matching prompts pass through untouched.
 */
export function rewriteSkillInvocationPrompt(
  prompt: string | ContentPart[],
  registry: SkillRegistry,
): string | ContentPart[] {
  if (typeof prompt === "string") {
    return parseSkillInvocation(prompt, registry)?.actualPrompt ?? prompt;
  }
  const index = prompt.findIndex((part) => part.type === "text");
  if (index === -1) return prompt;
  const part = prompt[index] as Extract<ContentPart, { type: "text" }>;
  const rewritten = parseSkillInvocation(part.text, registry)?.actualPrompt;
  if (!rewritten) return prompt;
  const next = prompt.slice();
  next[index] = { ...part, text: rewritten };
  return next;
}

// ── Building blocks (escape hatch for custom hosts) ────────────────────────

export { Agent, AgentAbortError, type AgentOptions, type AgentRunOptions } from "../agent.js";
export {
  SessionManager,
  getSessionsDir,
  type SessionSummary,
  type UserTurn,
  type RewindResult,
} from "../session.js";
export { PermissionAwareApprovalController } from "../approval/controller.js";
export { BashAllowlist } from "../approval/session-cache.js";
export type { ApprovalController, ApprovalDecision, ApprovalRequest } from "../approval/types.js";
export { createAllTools, buildToolPromptOptions, type PlanController } from "../tools/index.js";
export { buildSystemPrompt } from "../system-prompt.js";
export { FileStateTracker } from "../tools/file-state.js";
export { BudgetLedger } from "../agent/budget-ledger.js";
export { UserConfig } from "../config.js";
export {
  ProviderRegistry,
  encodeModel,
  decodeModel,
  displayModel,
  type ProviderProfile,
  type ModelInfo,
} from "../provider-registry.js";
export { createProviderInstance } from "../provider.js";
export { getDefaultThinkingLevel } from "../variant/variant-resolver.js";
export {
  QuestionController,
  QuestionRejectedError,
  type QuestionAnswer,
  type QuestionEvent,
  type QuestionRequest,
} from "../question/controller.js";
export { SkillRegistry } from "../skills/registry.js";
export { parseSkillInvocation, type SkillInvocation } from "../skills/invocation.js";
export type { SkillSummary } from "../skills/types.js";
export { GoalStore } from "../goal/store.js";
export { McpManager } from "../mcp/manager.js";
export { loadMcpConfig } from "../mcp/config.js";
export { ExternalHookController } from "../hooks/controller.js";
export {
  calculateUsageCost,
  getModelPricing,
  type ModelPricing,
  type PricingCurrency,
} from "../model-pricing.js";
export { registry as slashCommandRegistry } from "../slash-commands/index.js";
export type { SlashCommandContext } from "../slash-commands/types.js";
export type {
  AgentEvent,
  ContentPart,
  Message,
  PermissionMode,
  Provider,
  ThinkingLevel,
  Todo,
  TokenUsage,
  UsageCost,
  ToolRegistryEntry,
  ToolResult,
  ToolUpdate,
} from "../types.js";
