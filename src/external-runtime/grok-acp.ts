import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { GrokProfile } from "./grok-profile.js";
import type { GrokSpawn } from "./grok-process.js";
import { sanitizeGrokDiagnostic } from "./grok-process.js";
import { GrokRuntimeError } from "./grok-errors.js";
import { createBoundedGrokNdjsonStream } from "./grok-ndjson.js";

export interface GrokAcpHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void | Promise<void>;
  onPermissionRequest(params: acp.RequestPermissionRequest): Promise<string | undefined>;
  onPermissionViolation(sessionId?: string): void | Promise<void>;
  onCrash(error: GrokRuntimeError): void;
}

export interface GrokAcpClient {
  initialize(): Promise<void>;
  newSession(): Promise<GrokAcpSessionState>;
  loadSession(sessionId: string): Promise<GrokAcpSessionState>;
  setModel(sessionId: string, modelId: string): Promise<GrokAcpModelState | undefined>;
  prompt(sessionId: string, prompt: string, generation: number, signal?: AbortSignal): Promise<acp.PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface GrokAcpModelInfo {
  id: string;
  name: string;
  description?: string;
}

export interface GrokAcpModelState {
  currentModelId: string;
  availableModels: GrokAcpModelInfo[];
}

export interface GrokAcpSessionState {
  id: string;
  models?: GrokAcpModelState;
}

export type GrokAcpFactory = (options: {
  binary: string;
  profile: GrokProfile;
  workspace: string;
  modelId?: string;
  reasoningEffort?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  env: NodeJS.ProcessEnv;
  spawn: GrokSpawn;
  handlers: GrokAcpHandlers;
}) => GrokAcpClient;

export const GROK_ACP_ARGS = (
  workspace: string,
  modelId?: string,
  reasoningEffort?: string,
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" = "default",
): readonly string[] => [
  "--no-auto-update",
  "--cwd",
  workspace,
  "--no-memory",
  "--no-subagents",
  "--no-plan",
  "--disable-web-search",
  "--tools",
  "Read,Edit,Grep,Bash",
  "--permission-mode",
  permissionMode,
  "--sandbox",
  "strict",
  ...(modelId ? ["--model", modelId] : []),
  ...(modelId && reasoningEffort && reasoningEffort !== "off" ? ["--reasoning-effort", reasoningEffort] : []),
  "agent",
  "--no-leader",
  "stdio",
];

function processCrash(code: number | null, signal: NodeJS.Signals | null, diagnostic: string): GrokRuntimeError {
  const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
  return new GrokRuntimeError("process_crashed", `Grok runtime stopped unexpectedly (${reason}).`, diagnostic || undefined);
}

const MAX_GROK_STDERR_RAW_BYTES = 64 * 1024;

/**
 * Reassemble stderr before redaction so secrets split across arbitrary child
 * process chunks cannot bypass token patterns. If the private in-memory raw
 * buffer exceeds its cap, discard it wholesale and expose only a fixed notice.
 */
export class GrokDiagnosticBuffer {
  private raw = "";
  private overflowed = false;

  append(chunk: Buffer | string): void {
    if (this.overflowed) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (Buffer.byteLength(this.raw, "utf8") + Buffer.byteLength(text, "utf8") > MAX_GROK_STDERR_RAW_BYTES) {
      this.raw = "";
      this.overflowed = true;
      return;
    }
    this.raw += text;
  }

  sanitized(maxLength = 2048): string {
    if (this.overflowed) return "Grok ACP stderr exceeded the safe diagnostic limit.";
    return sanitizeGrokDiagnostic(this.raw, maxLength);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelState(value: unknown): GrokAcpModelState | undefined {
  if (!isRecord(value) || typeof value.currentModelId !== "string" || !Array.isArray(value.availableModels)) return undefined;
  const availableModels: GrokAcpModelInfo[] = [];
  for (const item of value.availableModels) {
    if (!isRecord(item)) return undefined;
    const id = typeof item.modelId === "string" ? item.modelId : typeof item.id === "string" ? item.id : undefined;
    if (!id) return undefined;
    availableModels.push({
      id,
      name: typeof item.name === "string" ? item.name : id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    });
  }
  if (availableModels.length === 0 || !availableModels.some((model) => model.id === value.currentModelId)) return undefined;
  return { currentModelId: value.currentModelId, availableModels };
}

function parseSessionResponse(value: unknown, fallbackId?: string): GrokAcpSessionState {
  if (!isRecord(value)) throw new GrokRuntimeError("protocol_error", "Grok ACP returned an invalid session response.");
  const id = typeof value.sessionId === "string" ? value.sessionId : fallbackId;
  if (!id) throw new GrokRuntimeError("protocol_error", "Grok ACP session response omitted its session ID.");
  const models = value.models === undefined ? undefined : parseModelState(value.models);
  if (value.models !== undefined && !models) {
    throw new GrokRuntimeError("protocol_error", "Grok ACP returned an invalid model catalog.");
  }
  return { id, ...(models ? { models } : {}) };
}

function parseInterceptedSessionUpdate(message: acp.AnyMessage): acp.SessionNotification | undefined {
  if (!("method" in message) || message.method !== acp.methods.client.session.update) return undefined;
  if ("id" in message) {
    throw new GrokRuntimeError("protocol_error", "Grok ACP sent session/update as a request.");
  }
  if (!isRecord(message.params)
    || typeof message.params.sessionId !== "string"
    || !isRecord(message.params.update)
    || typeof message.params.update.sessionUpdate !== "string") {
    throw new GrokRuntimeError("protocol_error", "Grok ACP sent an invalid session update.");
  }
  if (message.params._meta !== undefined && message.params._meta !== null && !isRecord(message.params._meta)) {
    throw new GrokRuntimeError("protocol_error", "Grok ACP sent invalid session metadata.");
  }
  return message.params as acp.SessionNotification;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class DefaultGrokAcpClient implements GrokAcpClient {
  private readonly child: ChildProcess;
  private readonly connection: acp.ClientConnection;
  private readonly stderr = new GrokDiagnosticBuffer();
  private disposed = false;
  private initialized = false;
  private crashReported = false;
  private crashError?: GrokRuntimeError;
  private readonly exited: Promise<void>;
  private notificationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: Parameters<GrokAcpFactory>[0]) {
    const child = options.spawn(options.binary, GROK_ACP_ARGS(
      options.workspace,
      options.modelId,
      options.reasoningEffort,
      options.permissionMode,
    ), {
      cwd: options.workspace,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new GrokRuntimeError("protocol_error", "Grok ACP did not provide stdio pipes.");
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr.append(chunk);
    });
    child.once("error", () => this.reportCrash(processCrash(null, null, this.stderr.sanitized())));
    child.once("exit", (code, signal) => {
      if (!this.disposed) this.reportCrash(processCrash(code, signal, this.stderr.sanitized()));
    });

    const rejectHostCapability = async (sessionId?: string): Promise<never> => {
      await this.enqueuePermissionViolation(sessionId);
      throw acp.RequestError.requestCancelled(undefined, "This host capability is not exposed by Bubble's Grok runtime.");
    };
    const app = acp
      .client({ name: "bubble-grok-runtime" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const optionId = await options.handlers.onPermissionRequest(params);
        if (!optionId || !params.options.some((option) => option.optionId === optionId)) {
          return { outcome: { outcome: "cancelled" as const } };
        }
        return { outcome: { outcome: "selected" as const, optionId } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.terminal.create, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.terminal.output, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.terminal.release, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.terminal.waitForExit, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.terminal.kill, async ({ params }) =>
        await rejectHostCapability(params.sessionId))
      .onRequest(acp.methods.client.elicitation.create, async ({ params }) =>
        await rejectHostCapability(
          "sessionId" in params && typeof params.sessionId === "string" ? params.sessionId : undefined,
        ))
      .onNotification(acp.methods.client.elicitation.complete, () =>
        this.enqueuePermissionViolation(undefined));
    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = createBoundedGrokNdjsonStream(input, output, {
      interceptIncoming: (message) => {
        const notification = parseInterceptedSessionUpdate(message);
        if (!notification) return false;
        void this.enqueueSessionUpdate(notification);
        return true;
      },
      onProtocolError: (error) => {
        this.reportCrash(error);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      },
    });
    this.connection = app.connect(stream);
  }

  private reportCrash(error: GrokRuntimeError): void {
    if (this.crashReported || this.disposed) return;
    this.crashReported = true;
    this.crashError = error;
    this.options.handlers.onCrash(error);
  }

  private enqueueSessionUpdate(notification: acp.SessionNotification): Promise<void> {
    const work = this.notificationTail.then(async () => {
      try {
        await this.options.handlers.onSessionUpdate(notification);
      } catch (cause) {
        const error = cause instanceof GrokRuntimeError
          ? cause
          : new GrokRuntimeError("protocol_error", "Grok ACP notification handling failed.");
        this.reportCrash(error);
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
      }
    });
    this.notificationTail = work;
    return work;
  }

  private enqueuePermissionViolation(sessionId?: string): Promise<void> {
    const work = this.notificationTail.then(async () => {
      try {
        await this.options.handlers.onPermissionViolation(sessionId);
      } catch (cause) {
        const error = cause instanceof GrokRuntimeError
          ? cause
          : new GrokRuntimeError("protocol_error", "Grok ACP policy handling failed.");
        this.reportCrash(error);
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
      }
    });
    this.notificationTail = work;
    return work;
  }

  private async drainNotifications(): Promise<void> {
    // Incoming requests/notifications are dispatched independently from the
    // response promise. Let already-parsed work join the ordered tail before
    // deciding that initialize/new/load completed safely.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.notificationTail;
    if (this.crashError) throw this.crashError;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let response: acp.InitializeResponse;
    try {
      response = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
        clientInfo: { name: "bubble", title: "Bubble", version: "1" },
      });
      await this.drainNotifications();
    } catch {
      if (this.crashError) throw this.crashError;
      throw new GrokRuntimeError(
        "protocol_error",
        "Grok ACP initialization failed.",
        this.stderr.sanitized() || undefined,
      );
    }
    if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new GrokRuntimeError("protocol_error", "Grok ACP returned an unsupported protocol version.");
    }
    if (response.agentCapabilities?.loadSession !== true) {
      throw new GrokRuntimeError("protocol_error", "Grok ACP must support session loading for isolated turn rotation.");
    }
    const authMethods = response.authMethods ?? [];
    const cached = authMethods.find((method) => method.id === "cached_token");
    if (!cached) {
      throw new GrokRuntimeError("not_authenticated", "Sign in to Grok before starting a subscription session.");
    }
    try {
      await this.connection.agent.request(acp.methods.agent.authenticate, { methodId: "cached_token" });
      await this.drainNotifications();
    } catch {
      if (this.crashError) throw this.crashError;
      throw new GrokRuntimeError("not_authenticated", "The cached Grok login is unavailable or expired.");
    }
    this.initialized = true;
  }

  async newSession(): Promise<GrokAcpSessionState> {
    await this.initialize();
    try {
      const response = await this.connection.agent.request<unknown, Record<string, unknown>>("session/new", {
        cwd: this.options.workspace,
        additionalDirectories: [],
        mcpServers: [],
      });
      await this.drainNotifications();
      return parseSessionResponse(response);
    } catch (error) {
      if (this.crashError) throw this.crashError;
      throw error;
    }
  }

  async loadSession(sessionId: string): Promise<GrokAcpSessionState> {
    await this.initialize();
    try {
      const response = await this.connection.agent.request<unknown, Record<string, unknown>>("session/load", {
        sessionId,
        cwd: this.options.workspace,
        additionalDirectories: [],
        mcpServers: [],
      });
      await this.drainNotifications();
      return parseSessionResponse(response, sessionId);
    } catch (error) {
      if (this.crashError) throw this.crashError;
      throw error;
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<GrokAcpModelState | undefined> {
    await this.initialize();
    try {
      const response = await this.connection.agent.request<unknown, { sessionId: string; modelId: string }>(
        "session/set_model",
        { sessionId, modelId },
      );
      await this.drainNotifications();
      if (!isRecord(response)) throw new GrokRuntimeError("protocol_error", "Grok ACP returned an invalid model switch response.");
      if (response.models === undefined) return undefined;
      const models = parseModelState(response.models);
      if (!models) throw new GrokRuntimeError("protocol_error", "Grok ACP returned an invalid model catalog.");
      return models;
    } catch (error) {
      if (this.crashError) throw this.crashError;
      throw error;
    }
  }

  async prompt(sessionId: string, prompt: string, generation: number, signal?: AbortSignal): Promise<acp.PromptResponse> {
    await this.initialize();
    try {
      const response = await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
          _meta: { bubbleGeneration: generation },
        },
        { cancellationSignal: signal },
      );
      // The SDK dispatches notification handlers independently from response
      // settlement. Yield once so all notifications parsed before the prompt
      // response can join our ordered tail, then drain it before rotating the
      // sidecar at the turn boundary.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.notificationTail;
      return response;
    } catch (error) {
      // Stream closure can reject the request one microtask before ChildProcess
      // emits exit. Give the exit handler a chance to preserve the safe crash
      // diagnostic instead of collapsing it into a generic protocol error.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (this.crashError) throw this.crashError;
      throw error;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.disposed) return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.close();
    this.child.stdin?.end();
    let stopped = await settlesWithin(this.exited, 250);
    if (!stopped && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      stopped = await settlesWithin(this.exited, 1_000);
    }
    if (!stopped && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await settlesWithin(this.exited, 1_000);
    }
  }
}

export const createDefaultGrokAcpClient: GrokAcpFactory = (options) => new DefaultGrokAcpClient(options);
