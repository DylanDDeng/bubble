import type { AgentEvent } from "../types.js";
import type { ThinkingLevel } from "../types.js";
import type { PermissionMode } from "../types.js";
import type { ApprovalController } from "../approval/types.js";
import { resolve } from "node:path";
import type {
  ExternalRuntimeBinaryInfo,
  ExternalRuntimeManager,
  ExternalRuntimeRunOptions,
  ExternalRuntimeSession,
  ExternalRuntimeModel,
  ExternalRuntimeModelSelection,
  ExternalRuntimeState,
  ExternalRuntimeStatus,
} from "./types.js";
import type { GrokBinaryDependencies } from "./grok-binary.js";
import { verifyGrokBinary } from "./grok-binary.js";
import {
  acquireGrokProfileLock,
  buildGrokChildEnv,
  clearGrokGeneratedExtensions,
  clearGrokRuntimeData,
  getGrokProfile,
  grokProfileHasAuth,
  prepareGrokProfile,
  prepareGrokProfileLockRoot,
  type GrokProfile,
  type GrokProfileLock,
} from "./grok-profile.js";
import {
  collectGrokProjectSkills,
  runGrokInspectJson,
  runGrokPreflight,
  validateGrokInspect,
} from "./grok-preflight.js";
import {
  defaultGrokSpawn,
  runGrokCommand,
  type GrokSpawn,
} from "./grok-process.js";
import {
  createDefaultGrokAcpClient,
  type GrokAcpClient,
  type GrokAcpFactory,
} from "./grok-acp.js";
import { GrokRuntimeError, safeErrorMessage } from "./grok-errors.js";
import { resolveGrokNetworkRoute, type GrokNetworkRoute } from "./grok-network.js";

export const GROK_RUNTIME_CAPABILITIES = Object.freeze({
  chat: true,
  tools: true,
  memory: false,
  subagents: false,
  plan: false,
  web: false,
  sessionLoad: true,
  workspace: true,
  modelControl: true,
  reasoningControl: true,
});

export interface GrokRuntimeDependencies extends GrokBinaryDependencies {
  bubbleHome?: string;
  parentEnv?: NodeJS.ProcessEnv;
  spawn?: GrokSpawn;
  acpFactory?: GrokAcpFactory;
  oauthOpener?: GrokOAuthOpener;
  networkResolver?: () => Promise<GrokNetworkRoute>;
  workspace?: string;
  approvalController?: ApprovalController;
  getPermissionMode?: () => PermissionMode;
}

export type GrokOAuthOpener = (url: string, signal: AbortSignal) => Promise<void>;

export function grokLoginFailureMessage(diagnostic: string): string {
  if (
    /(?:openid-configuration|error sending request|connection reset|connect(?:ion)? (?:failed|refused)|timed? out|dns error|name or service not known)/i
      .test(diagnostic)
  ) {
    return "Could not reach xAI, so no sign-in page was created. Check your network and try Grok Subscription again.";
  }
  return "Grok login did not complete.";
}

const defaultGrokOAuthOpener: GrokOAuthOpener = async (url, signal) => {
  const result = await runGrokCommand(defaultGrokSpawn, "/usr/bin/open", [url], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    signal,
    discardStdout: true,
    maxStdoutBytes: 4 * 1024,
    maxStderrBytes: 4 * 1024,
  });
  if (result.code !== 0) {
    throw new GrokRuntimeError("not_authenticated", "Unable to open the xAI sign-in page.");
  }
};

interface ActiveTurn {
  sessionId: string;
  generation: number;
  queue: AsyncEventQueue;
  cancelled: boolean;
}

type SessionLifecyclePhase = "idle" | "initializing" | "creating" | "loading";

const END = Symbol("end");

class AsyncEventQueue {
  private values: Array<AgentEvent | typeof END> = [];
  private waiters: Array<{
    resolve: (value: AgentEvent | typeof END) => void;
    reject: (error: unknown) => void;
  }> = [];
  private terminalError: unknown;
  private ended = false;

  push(value: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(END);
    else this.values.push(END);
    for (const extra of this.waiters.splice(0)) extra.resolve(END);
  }

  dropPendingOutput(): void {
    this.values = this.values.filter((value) => value === END || value.type === "turn_start");
  }

  fail(error: unknown, discardPendingOutput = false): void {
    if (this.ended) return;
    if (discardPendingOutput) this.dropPendingOutput();
    this.ended = true;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(): Promise<AgentEvent | typeof END> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.terminalError !== undefined) throw this.terminalError;
    if (this.ended) return END;
    return await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function notificationGeneration(meta: Record<string, unknown> | null | undefined): number | undefined {
  if (!meta) return undefined;
  for (const key of ["generation", "bubbleGeneration", "bubble_generation"]) {
    if (typeof meta[key] === "number") return meta[key] as number;
  }
  return undefined;
}

function externalToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { input };
}

function externalToolOutput(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 16 * 1024);
  try {
    return JSON.stringify(output ?? "", null, 2).slice(0, 16 * 1024);
  } catch {
    return "Grok tool returned an unreadable result.";
  }
}

export class GrokRuntimeManager implements ExternalRuntimeManager {
  private readonly deps: GrokRuntimeDependencies;
  private readonly spawn: GrokSpawn;
  private readonly acpFactory: GrokAcpFactory;
  private readonly oauthOpener: GrokOAuthOpener;
  private readonly profile: GrokProfile;
  private readonly workspace: string;
  private binary?: ExternalRuntimeBinaryInfo;
  private acp?: GrokAcpClient;
  private lock?: GrokProfileLock;
  private state: ExternalRuntimeState = "unavailable";
  private currentSessionId?: string;
  private attachedSessionId?: string;
  private activeTurn?: ActiveTurn;
  private nextGeneration = 0;
  private closingSidecar?: Promise<void>;
  private loginController?: AbortController;
  private loginOperation?: Promise<void>;
  private sessionLifecyclePhase: SessionLifecyclePhase = "idle";
  private networkRoute?: GrokNetworkRoute;
  private networkRouteOperation?: Promise<GrokNetworkRoute>;
  private modelId?: string;
  private reasoningEffort: ThinkingLevel = "high";
  private modelCache?: ExternalRuntimeModel[];
  private readonly activeTools = new Map<string, { name: string; args: Record<string, unknown> }>();

  constructor(deps: GrokRuntimeDependencies = {}) {
    this.deps = deps;
    this.spawn = deps.spawn ?? defaultGrokSpawn;
    this.acpFactory = deps.acpFactory ?? createDefaultGrokAcpClient;
    this.oauthOpener = deps.oauthOpener ?? defaultGrokOAuthOpener;
    this.profile = getGrokProfile(deps.bubbleHome);
    this.workspace = resolve(deps.workspace ?? process.cwd());
  }

  private status(message?: string): ExternalRuntimeStatus {
    return {
      provider: "grok",
      state: this.state,
      capabilities: GROK_RUNTIME_CAPABILITIES,
      binary: this.binary,
      sessionId: this.currentSessionId,
      message,
    };
  }

  private async ensureNetworkRoute(): Promise<GrokNetworkRoute> {
    if (this.networkRoute) return this.networkRoute;
    if (!this.networkRouteOperation) {
      const resolver = this.deps.networkResolver ?? resolveGrokNetworkRoute;
      this.networkRouteOperation = resolver()
        .then((route) => {
          this.networkRoute = route;
          return route;
        })
        .finally(() => {
          this.networkRouteOperation = undefined;
        });
    }
    return await this.networkRouteOperation;
  }

  private async prepareAndVerify(signal?: AbortSignal): Promise<{ profile: GrokProfile; env: NodeJS.ProcessEnv; binary: ExternalRuntimeBinaryInfo }> {
    await prepareGrokProfile(this.profile, this.deps.uid ?? process.getuid?.());
    const env = buildGrokChildEnv(
      this.profile,
      this.deps.parentEnv ?? process.env,
      this.networkRoute?.proxy,
    );
    const binary = await verifyGrokBinary({
      ...this.deps,
      readVersion: this.deps.readVersion ?? (async (path) => {
        const result = await runGrokCommand(this.spawn, path, ["--version"], {
          cwd: this.profile.workspace,
          env,
          signal,
          maxStdoutBytes: 4096,
        });
        if (result.code !== 0) {
          throw new GrokRuntimeError("binary_version_mismatch", "Unable to verify the Grok CLI version.", result.stderr);
        }
        return result.stdout;
      }),
    });
    this.binary = binary;
    return { profile: this.profile, env, binary };
  }

  private async acquireProfileLock(): Promise<GrokProfileLock> {
    await prepareGrokProfileLockRoot(this.profile, this.deps.uid ?? process.getuid?.());
    return await acquireGrokProfileLock(this.profile);
  }

  async inspect(): Promise<ExternalRuntimeStatus> {
    if (this.acp) return this.status();
    let temporaryLock: GrokProfileLock | undefined;
    try {
      temporaryLock = await this.acquireProfileLock();
      const { profile, env, binary } = await this.prepareAndVerify();
      await clearGrokGeneratedExtensions(profile);
      await runGrokPreflight(this.spawn, binary.path, profile, env, profile.workspace);
      await clearGrokGeneratedExtensions(profile);
      this.state = (await grokProfileHasAuth(profile)) ? "ready" : "signed_out";
      return this.status();
    } catch (error) {
      this.state = error instanceof GrokRuntimeError && error.code === "not_authenticated" ? "signed_out" : "unavailable";
      return this.status(safeErrorMessage(error));
    } finally {
      // Never mutate a profile owned by another Bubble process. Cleanup is
      // permitted only after this inspect call acquired the runtime lock.
      if (temporaryLock) {
        await clearGrokGeneratedExtensions(this.profile).catch(() => undefined);
      }
      await temporaryLock?.release();
    }
  }

  async login(signal?: AbortSignal, onBrowserOpened?: () => void): Promise<void> {
    if (this.loginOperation) {
      throw new GrokRuntimeError("protocol_error", "A Grok login is already in progress.");
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener("abort", relayAbort, { once: true });

    const operation = this.performLogin(controller, onBrowserOpened);
    this.loginController = controller;
    this.loginOperation = operation;
    try {
      await operation;
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      if (this.loginOperation === operation) this.loginOperation = undefined;
      if (this.loginController === controller) this.loginController = undefined;
    }
  }

  private async performLogin(controller: AbortController, onBrowserOpened?: () => void): Promise<void> {
    const signal = controller.signal;
    const profile = this.profile;
    await this.disconnect();
    if (signal.aborted) throw new GrokRuntimeError("cancelled", "Grok login cancelled.");
    await this.ensureNetworkRoute();
    const lock = await this.acquireProfileLock();
    let openerPromise: Promise<void> | undefined;
    let openerFailed = false;
    try {
      const { env, binary } = await this.prepareAndVerify(signal);
      await clearGrokGeneratedExtensions(profile);
      await runGrokPreflight(this.spawn, binary.path, profile, env, profile.workspace, signal);
      await clearGrokGeneratedExtensions(profile);
      await clearGrokRuntimeData(profile, true);
      if (signal.aborted) throw new GrokRuntimeError("cancelled", "Grok login cancelled.");
      const result = await runGrokCommand(
        this.spawn,
        binary.path,
        ["--no-auto-update", "--cwd", profile.workspace, "login", "--oauth"],
        {
          cwd: profile.workspace,
          env,
          signal,
          discardStdout: true,
          onOAuthAuthorizeUrl: (url) => {
            if (openerPromise) return;
            openerPromise = Promise.resolve()
              .then(async () => await this.oauthOpener(url, signal))
              .then(() => {
                try {
                  onBrowserOpened?.();
                } catch {
                  // UI status reporting must never invalidate a successful
                  // browser handoff or abort the OAuth process.
                }
              })
              .catch((error) => {
                openerFailed = true;
                if (!signal.aborted) controller.abort(error);
                throw error;
              });
            // The command may remain blocked waiting for browser completion;
            // attach a handler immediately so opener failure never becomes an
            // unhandled rejection while abort tears the child down.
            void openerPromise.catch(() => undefined);
          },
        },
      );
      await openerPromise;
      if (result.code !== 0 || !(await grokProfileHasAuth(profile))) {
        this.state = "signed_out";
        throw new GrokRuntimeError(
          "not_authenticated",
          grokLoginFailureMessage(result.stderr),
          result.stderr,
        );
      }
      await clearGrokRuntimeData(profile, false);
      await clearGrokGeneratedExtensions(profile);
      this.state = "ready";
    } catch (error) {
      this.state = "signed_out";
      await clearGrokRuntimeData(profile, true);
      await clearGrokGeneratedExtensions(profile);
      if (openerFailed) {
        throw new GrokRuntimeError("not_authenticated", "Unable to open the xAI sign-in page.");
      }
      if (signal.aborted) {
        throw new GrokRuntimeError("cancelled", "Grok login cancelled.");
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  async logout(): Promise<void> {
    await this.disconnect();
    const profile = this.profile;
    const lock = await this.acquireProfileLock();
    try {
      await prepareGrokProfile(profile, this.deps.uid ?? process.getuid?.());
      try {
        const { env, binary } = await this.prepareAndVerify();
        await runGrokCommand(
          this.spawn,
          binary.path,
          ["--no-auto-update", "--cwd", profile.workspace, "logout"],
          { cwd: profile.workspace, env },
        );
      } catch {
        // Local credential deletion below is authoritative for Bubble's
        // isolated profile. A missing/broken CLI must not make logout
        // impossible or leave the session binding stranded.
      }
      await clearGrokRuntimeData(profile, true);
      await clearGrokGeneratedExtensions(profile);
      if (await grokProfileHasAuth(profile)) {
        throw new GrokRuntimeError("profile_unsafe", "Grok credentials could not be removed from the isolated profile.");
      }
      this.currentSessionId = undefined;
      this.attachedSessionId = undefined;
      this.state = "signed_out";
    } finally {
      await lock.release();
    }
  }

  private async ensureConnected(): Promise<GrokAcpClient> {
    await this.closingSidecar;
    if (this.acp) return this.acp;
    await this.ensureNetworkRoute();
    const lock = await this.acquireProfileLock();
    let client: GrokAcpClient | undefined;
    try {
      const { profile, env, binary } = await this.prepareAndVerify();
      await clearGrokGeneratedExtensions(profile);
      // The pinned CLI always lists workspace project skills in inspect, even
      // once loading is disabled. Discover them first, write every name into
      // the profile's [skills] disabled list, then verify the workspace again
      // against exactly that allowlist before the sidecar may start.
      let payload = await runGrokInspectJson(this.spawn, binary.path, profile, env, this.workspace);
      const workspaceSkills = await collectGrokProjectSkills(payload, this.workspace);
      if (workspaceSkills.length > 0) {
        await prepareGrokProfile(this.profile, this.deps.uid ?? process.getuid?.(), workspaceSkills);
        await clearGrokGeneratedExtensions(profile);
        payload = await runGrokInspectJson(this.spawn, binary.path, profile, env, this.workspace);
      }
      await validateGrokInspect(payload, profile, this.workspace, {
        allowedProjectSkills: new Set(workspaceSkills),
        allowCompatMcpServers: true,
      });
      await clearGrokGeneratedExtensions(profile);
      if (!(await grokProfileHasAuth(profile))) {
        this.state = "signed_out";
        throw new GrokRuntimeError("not_authenticated", "Sign in to Grok before starting a subscription session.");
      }
      client = this.acpFactory({
        binary: binary.path,
        profile,
        workspace: this.workspace,
        modelId: this.modelId,
        reasoningEffort: this.reasoningEffort,
        permissionMode: this.deps.getPermissionMode?.() ?? "default",
        env,
        spawn: this.spawn,
        handlers: {
          onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
          onPermissionRequest: async (params) => {
            const reject = params.options.find((option) => option.kind === "reject_once")
              ?? params.options.find((option) => option.kind === "reject_always");
            if (!this.deps.approvalController) return reject?.optionId;
            const toolCall = params.toolCall;
            const decision = await this.deps.approvalController.request({
              type: "external_tool",
              toolCallId: toolCall.toolCallId,
              title: toolCall.title?.trim() || toolCall.kind || "Grok tool",
              kind: toolCall.kind || "other",
              rawInput: toolCall.rawInput,
              locations: toolCall.locations?.map((location) => ({
                path: location.path,
                line: location.line,
              })),
            });
            const kind = decision.action === "approve" ? "allow_once" : "reject_once";
            return params.options.find((option) => option.kind === kind)?.optionId
              ?? reject?.optionId;
          },
          onPermissionViolation: async (sessionId) => {
            await this.handlePolicyViolation(sessionId, "Grok requested an unsupported host capability.");
          },
          onCrash: (error) => this.handleCrash(error),
        },
      });
      this.sessionLifecyclePhase = "initializing";
      try {
        await client.initialize();
      } finally {
        this.sessionLifecyclePhase = "idle";
      }
      this.acp = client;
      this.lock = lock;
      this.attachedSessionId = undefined;
      this.state = "ready";
      return client;
    } catch (error) {
      await client?.dispose();
      await clearGrokGeneratedExtensions(this.profile).catch(() => undefined);
      await lock.release();
      throw error;
    }
  }

  private applyAcpModels(models: import("./grok-acp.js").GrokAcpModelState | undefined): void {
    if (!models) return;
    this.modelCache = models.availableModels.map((model) => {
      const reasoningLevels: ThinkingLevel[] = model.id === "grok-4.5"
        ? ["low", "medium", "high"]
        : ["off"];
      return {
        id: model.id,
        name: model.name,
        reasoningLevels,
        defaultReasoningLevel: model.id === "grok-4.5" ? "high" : "off",
      };
    });
    this.modelId = models.currentModelId;
    const current = this.modelCache.find((model) => model.id === this.modelId);
    if (current && !current.reasoningLevels.includes(this.reasoningEffort)) {
      this.reasoningEffort = current.defaultReasoningLevel;
    }
  }

  async newSession(): Promise<ExternalRuntimeSession> {
    const client = await this.ensureConnected();
    try {
      this.sessionLifecyclePhase = "creating";
      const session = await client.newSession();
      const id = session.id;
      this.applyAcpModels(session.models);
      this.currentSessionId = id;
      this.attachedSessionId = id;
      this.state = "ready";
      return {
        id,
        provider: "grok",
        modelId: this.modelId,
        reasoningEffort: this.reasoningEffort,
      };
    } catch (error) {
      throw error instanceof GrokRuntimeError
        ? error
        : new GrokRuntimeError("protocol_error", "Grok could not create a session.");
    } finally {
      this.sessionLifecyclePhase = "idle";
    }
  }

  async loadSession(id: string): Promise<ExternalRuntimeSession> {
    if (!id.trim()) throw new GrokRuntimeError("protocol_error", "A Grok session ID is required.");
    const client = await this.ensureConnected();
    try {
      this.sessionLifecyclePhase = "loading";
      const session = await client.loadSession(id);
      const loadedId = session.id;
      this.applyAcpModels(session.models);
      this.currentSessionId = loadedId;
      this.attachedSessionId = loadedId;
      this.state = "ready";
      return {
        id: loadedId,
        provider: "grok",
        modelId: this.modelId,
        reasoningEffort: this.reasoningEffort,
      };
    } catch (error) {
      throw error instanceof GrokRuntimeError
        ? error
        : new GrokRuntimeError("protocol_error", "Grok could not load that session.");
    } finally {
      this.sessionLifecyclePhase = "idle";
    }
  }

  async hydrateSession(
    id: string,
    modelId?: string,
    reasoningEffort?: ThinkingLevel,
  ): Promise<ExternalRuntimeSession> {
    const loaded = await this.loadSession(id);
    if (modelId && (this.modelId !== modelId || (reasoningEffort !== undefined && this.reasoningEffort !== reasoningEffort))) {
      const selection = await this.setModel(modelId, reasoningEffort);
      return { id, provider: "grok", ...selection };
    }
    return loaded;
  }

  async listModels(): Promise<ExternalRuntimeModel[]> {
    if (this.modelCache) return this.modelCache.map((model) => ({ ...model, reasoningLevels: [...model.reasoningLevels] }));
    if (this.activeTurn) throw new GrokRuntimeError("protocol_error", "Models cannot be refreshed during a Grok turn.");
    await this.ensureNetworkRoute();
    let temporaryLock: GrokProfileLock | undefined;
    try {
      if (!this.lock) temporaryLock = await this.acquireProfileLock();
      const { env, binary } = await this.prepareAndVerify();
      const result = await runGrokCommand(
        this.spawn,
        binary.path,
        ["--no-auto-update", "--cwd", this.workspace, "models"],
        { cwd: this.workspace, env, maxStdoutBytes: 64 * 1024 },
      );
      if (result.code !== 0) {
        throw new GrokRuntimeError("protocol_error", "Grok could not list subscription models.", result.stderr);
      }
      const defaultId = /^Default model:\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
      const ids = [...result.stdout.matchAll(/^\s*[*-]\s+(\S+)(?:\s+\(default\))?\s*$/gm)].map((match) => match[1]!);
      if (ids.length === 0) throw new GrokRuntimeError("protocol_error", "Grok returned an empty model list.");
      this.modelCache = [...new Set(ids)].map((id) => {
        const reasoningLevels: ThinkingLevel[] = id === "grok-4.5"
          ? ["low", "medium", "high"]
          : ["off"];
        return {
          id,
          name: id,
          reasoningLevels,
          defaultReasoningLevel: id === "grok-4.5" ? "high" : "off",
        };
      });
      if (!this.modelId || !this.modelCache.some((model) => model.id === this.modelId)) {
        this.modelId = this.modelCache.find((model) => model.id === defaultId)?.id ?? this.modelCache[0]!.id;
        const selected = this.modelCache.find((model) => model.id === this.modelId)!;
        this.reasoningEffort = selected.defaultReasoningLevel;
      }
      return this.modelCache.map((model) => ({ ...model, reasoningLevels: [...model.reasoningLevels] }));
    } finally {
      await temporaryLock?.release();
    }
  }

  getModelSelection(): ExternalRuntimeModelSelection {
    return { modelId: this.modelId, reasoningEffort: this.reasoningEffort };
  }

  async setModel(modelId: string, reasoningEffort?: ThinkingLevel): Promise<ExternalRuntimeModelSelection> {
    const models = await this.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new GrokRuntimeError("protocol_error", `Grok model \"${modelId}\" is unavailable.`);
    const nextEffort = reasoningEffort ?? model.defaultReasoningLevel;
    if (!model.reasoningLevels.includes(nextEffort)) {
      throw new GrokRuntimeError("protocol_error", `Reasoning effort \"${nextEffort}\" is unavailable for ${modelId}.`);
    }
    if (this.modelId === modelId && this.reasoningEffort === nextEffort) return this.getModelSelection();

    const previous = this.getModelSelection();
    const sessionId = this.currentSessionId;
    if (!sessionId) {
      throw new GrokRuntimeError("protocol_error", "Load the Grok session before switching its model.");
    }
    const client = await this.ensureConnected();
    try {
      const state = await client.setModel(sessionId, modelId);
      this.applyAcpModels(state);
      this.modelId = modelId;
      this.reasoningEffort = nextEffort;
      if (previous.reasoningEffort !== nextEffort) {
        await this.disconnect();
        await this.loadSession(sessionId);
        this.modelId = modelId;
        this.reasoningEffort = nextEffort;
      }
      return this.getModelSelection();
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      this.modelId = previous.modelId;
      this.reasoningEffort = previous.reasoningEffort;
      try {
        const rollback = await this.loadSession(sessionId);
        if (previous.modelId) {
          const rollbackClient = await this.ensureConnected();
          this.applyAcpModels(await rollbackClient.setModel(rollback.id, previous.modelId));
        }
        this.modelId = previous.modelId;
        this.reasoningEffort = previous.reasoningEffort;
      } catch {
        // Preserve the original switch failure; the next prompt will retry the
        // persisted Bubble selection against the same external session.
      }
      throw error;
    }
  }

  private async ensureSession(requested?: string): Promise<string> {
    const desired = requested ?? this.currentSessionId;
    if (!desired) return (await this.newSession()).id;
    if (this.attachedSessionId === desired) return desired;
    return (await this.loadSession(desired)).id;
  }

  async *run(prompt: string, options: ExternalRuntimeRunOptions = {}): AsyncIterable<AgentEvent> {
    if (this.activeTurn) throw new GrokRuntimeError("protocol_error", "A Grok turn is already running.");
    const client = await this.ensureConnected();
    const sessionId = await this.ensureSession(options.sessionId);
    const generation = options.generation ?? ++this.nextGeneration;
    const queue = new AsyncEventQueue();
    const turn: ActiveTurn = { sessionId, generation, queue, cancelled: false };
    this.activeTurn = turn;
    this.activeTools.clear();
    this.state = "running";
    queue.push({ type: "turn_start" });

    const abort = () => {
      turn.cancelled = true;
      turn.queue.dropPendingOutput();
      void client.cancel(sessionId).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    void client.prompt(sessionId, prompt, generation, options.signal).then(
      async (response) => {
        if (this.activeTurn !== turn) return;
        this.activeTurn = undefined;
        this.activeTools.clear();
        try {
          await this.closeSidecar();
          if (turn.cancelled || response.stopReason === "cancelled") {
            turn.cancelled = true;
            queue.fail(new GrokRuntimeError("cancelled", "Grok turn cancelled."), true);
            this.state = "ready";
            return;
          }
          queue.push({ type: "turn_end" });
          queue.end();
          this.state = "ready";
        } catch {
          queue.fail(new GrokRuntimeError("protocol_error", "Grok sidecar cleanup failed."));
          this.state = "failed";
        }
      },
      async (promptError) => {
        if (this.activeTurn !== turn) return;
        this.activeTurn = undefined;
        this.activeTools.clear();
        await this.closeSidecar().catch(() => undefined);
        const error = turn.cancelled
          ? new GrokRuntimeError("cancelled", "Grok turn cancelled.")
          : promptError instanceof GrokRuntimeError
            ? promptError
            : new GrokRuntimeError("protocol_error", "Grok prompt failed.");
        queue.fail(error, turn.cancelled);
        this.state = turn.cancelled ? "ready" : "failed";
      },
    );

    try {
      while (true) {
        const event = await queue.next();
        if (event === END) break;
        yield event;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.activeTurn === turn) {
        turn.cancelled = true;
        turn.queue.dropPendingOutput();
        this.activeTurn = undefined;
        this.activeTools.clear();
        this.state = "ready";
        await client.cancel(sessionId).catch(() => undefined);
        await this.closeSidecar();
      }
    }
  }

  async cancel(sessionId = this.activeTurn?.sessionId ?? this.currentSessionId): Promise<void> {
    if (!sessionId || !this.acp) return;
    if (this.activeTurn?.sessionId === sessionId) {
      this.activeTurn.cancelled = true;
      this.activeTurn.queue.dropPendingOutput();
      this.activeTools.clear();
    }
    await this.acp.cancel(sessionId);
  }

  private async handlePolicyViolation(
    _sessionId: string | undefined,
    message: string,
    diagnostic?: string,
  ): Promise<void> {
    const turn = this.activeTurn;
    const error = new GrokRuntimeError("policy_violation", message, diagnostic);
    if (!turn) {
      this.state = "failed";
      throw error;
    }
    turn.cancelled = true;
    this.activeTurn = undefined;
    this.state = "failed";
    await this.acp?.cancel(turn.sessionId).catch(() => undefined);
    await this.closeSidecar().catch(() => undefined);
    turn.queue.fail(error, true);
  }

  private async handleSessionUpdate(notification: import("@agentclientprotocol/sdk").SessionNotification): Promise<void> {
    const update = notification.update;
    // Grok 0.2.93 advertises slash metadata while initializing/loading. It is
    // inert in Bubble's constrained composer and is the sole update allowed
    // to disappear when no prompt turn is active. Built-in commands carry no
    // _meta; skill-backed commands always do (scope + SKILL.md path), so any
    // annotated command means an extension escaped the disabled list — for
    // example a skill created inside the workspace after the preflight ran.
    if (update.sessionUpdate === "available_commands_update") {
      const commands = (update as { availableCommands?: unknown }).availableCommands;
      const advertised = Array.isArray(commands) ? commands : [];
      for (const command of advertised) {
        const meta = command && typeof command === "object" ? (command as { _meta?: unknown })._meta : undefined;
        if (meta !== undefined && meta !== null) {
          await this.handlePolicyViolation(
            notification.sessionId,
            "Grok loaded a workspace skill that Bubble did not disable.",
          );
          return;
        }
      }
      return;
    }

    // session/load legitimately replays the stored transcript, including
    // historical tool/plan records. These notifications are inert data: no
    // Bubble turn exists, nothing is rendered or persisted, and any actual
    // host capability request still takes the separate fail-closed path.
    if (!this.activeTurn && this.sessionLifecyclePhase === "loading") return;

    const turn = this.activeTurn;
    const safeTurnUpdate = update.sessionUpdate === "agent_message_chunk"
      || update.sessionUpdate === "agent_thought_chunk"
      || update.sessionUpdate === "user_message_chunk"
      || update.sessionUpdate === "usage_update"
      || update.sessionUpdate === "tool_call"
      || update.sessionUpdate === "tool_call_update";
    if (!safeTurnUpdate) {
      const message = "Grok emitted an unsupported ACP session update.";
      const updateKind = /^[a-z_]{1,64}$/.test(update.sessionUpdate)
        ? `sessionUpdate=${update.sessionUpdate}`
        : undefined;
      await this.handlePolicyViolation(notification.sessionId, message, updateKind);
      return;
    }
    if (!turn) {
      // ACP session/load may replay transcript and usage chunks. They are not
      // part of a Bubble prompt generation, so consume them without exposing
      // or persisting them. Dangerous/unknown updates were rejected above.
      return;
    }
    if (turn.cancelled || notification.sessionId !== turn.sessionId) return;
    const generation = notificationGeneration(notification._meta);
    if (generation !== undefined && generation !== turn.generation) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turn.queue.push({ type: "text_delta", content: update.content.text });
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      turn.queue.push({ type: "reasoning_delta", content: update.content.text });
      return;
    }
    if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const existing = this.activeTools.get(update.toolCallId);
      const name = update.title?.trim() || existing?.name || update.kind || "Grok tool";
      const args = update.rawInput !== undefined ? externalToolArgs(update.rawInput) : existing?.args ?? {};
      if (!existing) {
        this.activeTools.set(update.toolCallId, { name, args });
        turn.queue.push({ type: "tool_start", id: update.toolCallId, name, args });
      } else {
        this.activeTools.set(update.toolCallId, { name, args });
      }
      if (update.status === "completed" || update.status === "failed") {
        turn.queue.push({
          type: "tool_end",
          id: update.toolCallId,
          name,
          result: {
            content: externalToolOutput(update.rawOutput ?? update.content),
            isError: update.status === "failed",
            status: update.status === "failed" ? "command_error" : "success",
            metadata: { kind: "internal", externalRuntime: "grok" },
          },
        });
        this.activeTools.delete(update.toolCallId);
      }
      return;
    }
  }

  private handleCrash(error: GrokRuntimeError): void {
    this.state = "failed";
    this.activeTurn?.queue.fail(error);
    this.activeTurn = undefined;
    this.activeTools.clear();
    void this.closeSidecar().catch(() => undefined);
  }

  private async closeSidecar(): Promise<void> {
    if (this.closingSidecar) return await this.closingSidecar;
    const client = this.acp;
    const lock = this.lock;
    this.acp = undefined;
    this.lock = undefined;
    this.attachedSessionId = undefined;
    const closing = (async () => {
      try {
        await client?.dispose();
      } finally {
        try {
          if (client) await clearGrokGeneratedExtensions(this.profile);
        } finally {
          await lock?.release();
        }
      }
    })();
    this.closingSidecar = closing;
    try {
      await closing;
    } finally {
      if (this.closingSidecar === closing) this.closingSidecar = undefined;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.activeTurn) {
      this.activeTurn.cancelled = true;
      this.activeTurn.queue.fail(new GrokRuntimeError("cancelled", "Grok runtime disconnected."), true);
      this.activeTurn = undefined;
    }
    this.activeTools.clear();
    await this.closeSidecar();
  }

  /**
   * Closes the current sidecar and releases the profile lock. The manager is
   * intentionally reusable: a later new/load/run call starts a fresh sidecar.
   */
  async dispose(): Promise<void> {
    const login = this.loginOperation;
    if (login) {
      this.loginController?.abort(new GrokRuntimeError("cancelled", "Grok login cancelled during shutdown."));
      await login.catch(() => undefined);
    }
    await this.disconnect();
    this.state = "disposed";
  }
}

export function createGrokRuntimeManager(deps: GrokRuntimeDependencies = {}): GrokRuntimeManager {
  return new GrokRuntimeManager(deps);
}
