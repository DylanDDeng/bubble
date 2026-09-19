import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  type Message,
} from "vscode-jsonrpc/node.js";
import { customLspServerEntries, isLspEnabled, isLspServerEnabled, type LspConfig, type LspServerId } from "./config.js";
import type { LspDiagnostic } from "./diagnostics.js";

// vscode-jsonrpc 8.x rethrows write failures inside an async Promise executor.
// Dispose through the lifecycle handler instead: pending requests still reject,
// without an additional unhandled rejection that can crash the desktop host.
class LspMessageWriter extends StreamMessageWriter {
  constructor(stream: ChildProcessWithoutNullStreams["stdin"], private readonly onWriteFailure: (error: unknown) => void) {
    super(stream);
  }

  override async write(message: Message): Promise<void> {
    try {
      await super.write(message);
    } catch (error) {
      this.onWriteFailure(error);
    }
  }
}

export type LspStatusKind = "starting" | "connected" | "error";

export interface LspStatus {
  id: string;
  name: string;
  root: string;
  status: LspStatusKind;
  message?: string;
}

export interface LspLocationInput {
  file: string;
  line: number;
  character: number;
}

export interface LspService {
  onStatusChange(listener: () => void): () => void;
  isDisabled(): boolean;
  updateConfig(config?: LspConfig): void;
  status(): LspStatus[];
  hasClients(filePath: string): Promise<boolean>;
  touchFile(filePath: string, diagnostics?: "document" | "full"): Promise<void>;
  diagnostics(): Record<string, LspDiagnostic[]>;
  restart(): Promise<void>;
  hover(input: LspLocationInput): Promise<unknown[]>;
  definition(input: LspLocationInput): Promise<unknown[]>;
  references(input: LspLocationInput): Promise<unknown[]>;
  implementation(input: LspLocationInput): Promise<unknown[]>;
  documentSymbol(filePath: string): Promise<unknown[]>;
  workspaceSymbol(query: string): Promise<unknown[]>;
  prepareCallHierarchy(input: LspLocationInput): Promise<unknown[]>;
  incomingCalls(input: LspLocationInput): Promise<unknown[]>;
  outgoingCalls(input: LspLocationInput): Promise<unknown[]>;
}

interface LspDocumentState {
  languageId: string;
  version: number;
}

interface LspClientState {
  key: string;
  id: LspServerId;
  name: string;
  root: string;
  languageId(file: string): string;
  process: ChildProcessWithoutNullStreams;
  connection: MessageConnection;
  documents: Map<string, LspDocumentState>;
  stopping: boolean;
  fail(message: string): void;
}

interface LspServerHandle {
  process: ChildProcessWithoutNullStreams;
  initializationOptions?: Record<string, unknown>;
}

interface LspServerInfo {
  id: LspServerId;
  name: string;
  extensions: string[];
  root(file: string, ctx: LspServerContext): Promise<string | undefined>;
  spawn(root: string, ctx: LspServerContext): Promise<LspServerHandle | undefined>;
  languageId(file: string): string;
  configuration?(root: string, items: unknown[]): unknown[];
}

interface LspServerContext {
  cwd: string;
}

interface PendingDiagnosticWaiter {
  file: string;
  resolve: () => void;
  timeout: NodeJS.Timeout;
}

export interface LspTimeouts {
  initializeMs?: number;
  requestMs?: number;
  shutdownMs?: number;
}

// Electron's executable is also a Node runtime, but only with this child-local
// flag. Preserve it for descendants (e.g. typescript-language-server's tsserver).
function spawnNodeServer(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, args, {
    cwd,
    env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
    stdio: "pipe",
  });
}

const execFile = promisify(execFileCallback);
const services = new Map<string, ProjectLspService>();
const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const NODE_ROOT_MARKERS = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package.json"];
const DENO_ROOT_MARKERS = ["deno.json", "deno.jsonc"];

export class ProjectLspService implements LspService {
  private readonly emitter = new EventEmitter();
  private readonly clients = new Map<string, LspClientState>();
  private readonly spawning = new Map<string, Promise<LspClientState | undefined>>();
  private readonly initializing = new Map<string, LspClientState>();
  private generation = 0;
  private readonly starting = new Map<string, LspStatus>();
  private readonly broken = new Map<string, LspStatus>();
  private readonly unavailable = new Set<string>();
  private readonly diagnosticsByFile = new Map<string, Map<string, LspDiagnostic[]>>();
  private readonly waiters = new Set<PendingDiagnosticWaiter>();
  private disposed = false;
  private config: LspConfig | undefined;

  constructor(private readonly cwd: string, config?: LspConfig, private readonly timeouts: LspTimeouts = {}) {
    this.config = config;
  }

  updateConfig(config?: LspConfig): void {
    const wasDisabled = this.isDisabled();
    this.config = config;
    this.unavailable.clear();
    this.broken.clear();
    if (!wasDisabled && this.isDisabled()) {
      void this.shutdownClients();
    } else {
      void this.shutdownDisabledClients();
    }
    this.emitStatus();
  }

  async restart(): Promise<void> {
    this.broken.clear();
    this.unavailable.clear();
    await this.shutdownClients();
    this.emitStatus();
  }

  onStatusChange(listener: () => void): () => void {
    this.emitter.on("status", listener);
    return () => this.emitter.off("status", listener);
  }

  isDisabled(): boolean {
    return !isLspEnabled(this.config);
  }

  status(): LspStatus[] {
    const connected = [...this.clients.values()].map((client): LspStatus => ({
      id: client.id,
      name: client.name,
      root: relative(this.cwd, client.root) || ".",
      status: "connected",
    }));
    const starting = [...this.starting.entries()]
      .filter(([key]) => !this.clients.has(key) && !this.broken.has(key))
      .map(([, status]) => status);
    return [...connected, ...starting, ...this.broken.values()];
  }

  async hasClients(filePath: string): Promise<boolean> {
    const file = this.resolveInsideCwd(filePath);
    if (!file) return false;
    return (await this.matchingServers(file)).length > 0;
  }

  async touchFile(filePath: string, diagnostics?: "document" | "full"): Promise<void> {
    const file = this.resolveInsideCwd(filePath);
    if (!file) return;
    const clients = await this.getClients(file);
    if (!clients.length) return;
    await Promise.all(clients.map((client) => this.openOrChange(client, file)));
    if (diagnostics) {
      await this.waitForDiagnostics(file, diagnostics === "full" ? 8000 : 3500);
    }
  }

  diagnostics(): Record<string, LspDiagnostic[]> {
    const result: Record<string, LspDiagnostic[]> = {};
    for (const [file, byServer] of this.diagnosticsByFile.entries()) {
      result[file] = [...byServer.values()].flat();
    }
    return result;
  }

  async hover(input: LspLocationInput): Promise<unknown[]> {
    return this.runRequest(input, "textDocument/hover", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    });
  }

  async definition(input: LspLocationInput): Promise<unknown[]> {
    return this.runRequest(input, "textDocument/definition", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    });
  }

  async references(input: LspLocationInput): Promise<unknown[]> {
    return this.runRequest(input, "textDocument/references", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
      context: { includeDeclaration: true },
    });
  }

  async implementation(input: LspLocationInput): Promise<unknown[]> {
    return this.runRequest(input, "textDocument/implementation", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    });
  }

  async documentSymbol(filePath: string): Promise<unknown[]> {
    const file = this.resolveInsideCwd(filePath);
    if (!file) return [];
    const clients = await this.getClients(file);
    await Promise.all(clients.map((client) => this.openOrChange(client, file)));
    const results = await Promise.all(
      clients.map((client) =>
        this.request(client, "textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } })
          .catch(() => []),
      ),
    );
    return results.flatMap(normalizeLspResult);
  }

  async workspaceSymbol(query: string): Promise<unknown[]> {
    const results = await Promise.all(
      [...this.clients.values()].map((client) =>
        this.request(client, "workspace/symbol", { query }).catch(() => []),
      ),
    );
    return results.flatMap(normalizeLspResult).slice(0, 50);
  }

  async prepareCallHierarchy(input: LspLocationInput): Promise<unknown[]> {
    return this.runRequest(input, "textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    });
  }

  async incomingCalls(input: LspLocationInput): Promise<unknown[]> {
    return this.callHierarchyRequest(input, "callHierarchy/incomingCalls");
  }

  async outgoingCalls(input: LspLocationInput): Promise<unknown[]> {
    return this.callHierarchyRequest(input, "callHierarchy/outgoingCalls");
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    this.waiters.clear();
    await this.shutdownClients();
  }

  shutdownNow(): void {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
    this.disposed = true;
    this.generation += 1;
    for (const client of [...this.initializing.values(), ...this.clients.values()]) this.stopClient(client);
    this.starting.clear();
  }

  private async runRequest(input: LspLocationInput, method: string, params: unknown): Promise<unknown[]> {
    const file = this.resolveInsideCwd(input.file);
    if (!file) return [];
    const clients = await this.getClients(file);
    await Promise.all(clients.map((client) => this.openOrChange(client, file)));
    const results = await Promise.all(
      clients.map((client) => this.request(client, method, params).catch(() => [])),
    );
    return results.flatMap(normalizeLspResult);
  }

  private async callHierarchyRequest(input: LspLocationInput, method: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls"): Promise<unknown[]> {
    const file = this.resolveInsideCwd(input.file);
    if (!file) return [];
    const clients = await this.getClients(file);
    const results = await Promise.all(clients.map(async (client) => {
      await this.openOrChange(client, file);
      const items = await this.request(client, "textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => []);
      const first = normalizeLspResult(items)[0];
      if (!first) return [];
      return this.request(client, method, { item: first }).catch(() => []);
    }));
    return results.flatMap(normalizeLspResult);
  }

  private async getClients(file: string): Promise<LspClientState[]> {
    if (this.disposed) return [];
    const matches = await this.matchingServers(file);
    const clients = await Promise.all(matches.map(({ server, root }) => this.getClient(server, root)));
    return clients.filter((client): client is LspClientState => !!client);
  }

  private async getClient(server: LspServerInfo, root: string): Promise<LspClientState | undefined> {
    if (this.disposed) return undefined;
    const key = `${root}:${server.id}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    if (this.broken.has(key)) return undefined;
    if (this.unavailable.has(key)) return undefined;
    const inflight = this.spawning.get(key);
    if (inflight) return inflight;

    this.starting.set(key, {
      id: server.id,
      name: server.name,
      root: relative(this.cwd, root) || ".",
      status: "starting",
      message: "starting",
    });
    this.emitStatus();
    const task = this.spawnClient(server, root, key);
    this.spawning.set(key, task);
    task.finally(() => {
      if (this.spawning.get(key) === task) {
        this.spawning.delete(key);
        if (this.starting.delete(key)) this.emitStatus();
      }
    });
    return task;
  }

  private async spawnClient(server: LspServerInfo, root: string, key: string): Promise<LspClientState | undefined> {
    const generation = this.generation;
    let client: LspClientState | undefined;
    try {
      const handle = await server.spawn(root, { cwd: this.cwd });
      if (!handle) {
        this.unavailable.add(key);
        return undefined;
      }
      if (this.disposed || generation !== this.generation || !isLspServerEnabled(this.config, server.id)) {
        // Install an error handler even when shutdown won the spawn race.
        handle.process.on("error", () => {});
        handle.process.kill();
        return undefined;
      }
      const connection = createMessageConnection(
        new StreamMessageReader(handle.process.stdout),
        new LspMessageWriter(handle.process.stdin, (error) => client?.fail(`server write failed: ${String(error)}`)),
        {
          error: () => {},
          warn: () => {},
          info: () => {},
          log: () => {},
        },
      );
      client = {
        key,
        id: server.id,
        name: server.name,
        root,
        languageId: server.languageId,
        process: handle.process,
        connection,
        documents: new Map(),
        stopping: false,
        fail: (message) => {
          if (client!.stopping) return;
          this.stopClient(client!);
          if (!this.disposed && generation === this.generation) this.markBroken(key, server, root, message);
        },
      };
      const activeClient = client;
      this.initializing.set(key, client);
      // Drain stderr: an unread pipe can block an otherwise healthy server.
      handle.process.stderr.resume();
      handle.process.once("error", (error) => activeClient.fail(`server error: ${error.message}`));
      handle.process.once("exit", (code, signal) => activeClient.fail(
        `server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      ));
      connection.onClose(() => activeClient.fail("server connection closed"));
      connection.onError(([error]) => activeClient.fail(`server connection error: ${error.message}`));

      connection.onNotification("textDocument/publishDiagnostics", (params: any) => {
        if (!params?.uri) return;
        const file = normalize(fileURLToPath(params.uri));
        const byServer = this.diagnosticsByFile.get(file) ?? new Map<string, LspDiagnostic[]>();
        byServer.set(server.id, params.diagnostics ?? []);
        this.diagnosticsByFile.set(file, byServer);
        this.resolveDiagnosticWaiters(file);
      });
      connection.onRequest("workspace/configuration", (params: any) =>
        server.configuration?.(root, Array.isArray(params?.items) ? params.items : []) ?? [],
      );
      connection.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(root).href, name: basename(root) }]);
      connection.onRequest("client/registerCapability", () => null);
      connection.onRequest("client/unregisterCapability", () => null);
      connection.listen();

      await this.request(client, "initialize", {
        processId: process.pid,
        rootPath: root,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: basename(root) }],
        initializationOptions: handle.initializationOptions ?? {},
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: true, didSave: true },
            hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: true },
            references: { dynamicRegistration: true },
            implementation: { dynamicRegistration: true },
            documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
            callHierarchy: { dynamicRegistration: true },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: { dynamicRegistration: true },
          },
          window: { workDoneProgress: false },
        },
      }, this.timeouts.initializeMs ?? 10_000);
      if (client.stopping || this.disposed || generation !== this.generation) return undefined;
      await this.notify(client, "initialized", {});
      if (client.stopping || this.disposed || generation !== this.generation) return undefined;
      this.clients.set(key, client);
      this.emitStatus();
      return client;
    } catch (error) {
      if (client) client.fail(error instanceof Error ? error.message : String(error));
      else if (!this.disposed && generation === this.generation) {
        this.markBroken(key, server, root, error instanceof Error ? error.message : String(error));
      }
      return undefined;
    } finally {
      if (this.initializing.get(key) === client) this.initializing.delete(key);
    }
  }

  private async request(client: LspClientState, method: string, params?: unknown, timeoutMs = this.timeouts.requestMs ?? 10_000): Promise<unknown> {
    return this.withDeadline(client, method, () => client.connection.sendRequest(method, params), timeoutMs);
  }

  private async notify(client: LspClientState, method: string, params: unknown): Promise<void> {
    await this.withDeadline(client, method, () => client.connection.sendNotification(method, params));
  }

  private async withDeadline<T>(client: LspClientState, method: string, operation: () => Promise<T>, timeoutMs = this.timeouts.requestMs ?? 10_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const message = `${method} timed out after ${timeoutMs}ms`;
            reject(new Error(message));
            client.fail(message);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private stopClient(client: LspClientState): void {
    client.stopping = true;
    if (this.clients.get(client.key) === client) this.clients.delete(client.key);
    if (this.initializing.get(client.key) === client) this.initializing.delete(client.key);
    // JSON-RPC close alone does not reject pending requests; dispose does.
    client.connection.dispose();
    if (client.process.exitCode === null && client.process.signalCode === null) {
      client.process.kill();
      const forceKill = setTimeout(() => {
        if (client.process.exitCode === null && client.process.signalCode === null) client.process.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
      client.process.once("exit", () => clearTimeout(forceKill));
    }
    for (const file of client.documents.keys()) {
      this.diagnosticsByFile.get(file)?.delete(client.id);
      this.resolveDiagnosticWaiters(file);
    }
  }

  private async openOrChange(client: LspClientState, file: string): Promise<void> {
    const text = await readFile(file, "utf-8");
    const languageId = client.languageId(file);
    const uri = pathToFileURL(file).href;
    const existing = client.documents.get(file);
    if (!existing) {
      client.documents.set(file, { languageId, version: 1 });
      await this.notify(client, "textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    existing.version += 1;
    await this.notify(client, "textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });
  }

  private waitForDiagnostics(file: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => done(), timeoutMs);
      const debounce = setTimeout(() => {
        if (this.diagnosticsByFile.has(file)) done();
      }, 150);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(debounce);
        this.waiters.delete(waiter);
        resolve();
      };
      const waiter: PendingDiagnosticWaiter = { file, resolve: done, timeout };
      this.waiters.add(waiter);
    });
  }

  private resolveDiagnosticWaiters(file: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.file !== file) continue;
      waiter.resolve();
    }
  }

  private async matchingServers(file: string): Promise<Array<{ server: LspServerInfo; root: string }>> {
    if (!isLspEnabled(this.config)) return [];
    const extension = extname(file) || file;
    const result: Array<{ server: LspServerInfo; root: string }> = [];
    for (const server of this.servers()) {
      if (!isLspServerEnabled(this.config, server.id)) continue;
      if (server.extensions.length && !server.extensions.includes(extension)) continue;
      const root = await server.root(file, { cwd: this.cwd });
      if (!root) continue;
      if (this.broken.has(`${root}:${server.id}`)) continue;
      result.push({ server, root });
    }
    return result;
  }

  private servers(): LspServerInfo[] {
    return [...BUILTIN_SERVERS, ...customServers(this.config)];
  }

  private markBroken(key: string, server: LspServerInfo, root: string, message: string): void {
    this.starting.delete(key);
    this.broken.set(key, {
      id: server.id,
      name: server.name,
      root: relative(this.cwd, root) || ".",
      status: "error",
      message,
    });
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emitter.emit("status");
  }

  private resolveInsideCwd(filePath: string): string | undefined {
    const file = normalize(isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath));
    const rel = relative(this.cwd, file);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return file;
  }

  private async shutdownClient(client: LspClientState): Promise<void> {
    client.stopping = true;
    try {
      await this.request(client, "shutdown", undefined, this.timeouts.shutdownMs ?? 1_000);
      await this.withDeadline(client, "exit", () => client.connection.sendNotification("exit"), this.timeouts.shutdownMs ?? 1_000);
    } catch {
      // Shutdown must finish even if the server no longer answers.
    } finally {
      this.stopClient(client);
    }
  }

  private async shutdownClients(): Promise<void> {
    this.generation += 1;
    for (const client of [...this.initializing.values()]) this.stopClient(client);
    this.spawning.clear();
    await Promise.all([...this.clients.values()].map((client) => this.shutdownClient(client)));
    this.clients.clear();
    this.starting.clear();
    this.diagnosticsByFile.clear();
  }

  private async shutdownDisabledClients(): Promise<void> {
    for (const client of [...this.initializing.values()]) {
      if (!isLspServerEnabled(this.config, client.id)) this.stopClient(client);
    }
    const disabled = [...this.clients.values()].filter((client) => !isLspServerEnabled(this.config, client.id));
    await Promise.all(disabled.map((client) => this.shutdownClient(client)));
  }
}

export const TypeScriptLspService = ProjectLspService;

export function getLspService(cwd: string, config?: LspConfig): ProjectLspService {
  const key = resolve(cwd);
  const existing = services.get(key);
  if (existing) {
    existing.updateConfig(config);
    return existing;
  }
  const service = new ProjectLspService(key, config);
  services.set(key, service);
  process.once("exit", () => service.shutdownNow());
  return service;
}

const TypeScriptServer: LspServerInfo = {
  id: "typescript",
  name: "typescript",
  extensions: TS_EXTENSIONS,
  root: nearestRoot(NODE_ROOT_MARKERS, DENO_ROOT_MARKERS),
  languageId: languageIdFor,
  async spawn(root, _ctx) {
    const requireFromRoot = createRequire(join(root, "package.json"));
    const requireFromSelf = createRequire(import.meta.url);
    const tsserverPath = resolveModule(requireFromRoot, "typescript/lib/tsserver.js")
      ?? resolveModule(requireFromSelf, "typescript/lib/tsserver.js");
    const serverPath = resolveModule(requireFromRoot, "typescript-language-server/lib/cli.mjs")
      ?? resolveModule(requireFromSelf, "typescript-language-server/lib/cli.mjs");
    if (!tsserverPath || !serverPath) return undefined;
    return {
      process: spawnNodeServer([serverPath, "--stdio"], root),
      initializationOptions: { tsserver: { path: tsserverPath } },
    };
  },
};

const DenoServer: LspServerInfo = {
  id: "deno",
  name: "deno",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  root: denoRoot,
  languageId: languageIdFor,
  async spawn(root) {
    const deno = await findExecutable("deno", [root]);
    if (!deno) return undefined;
    return {
      process: spawn(deno, ["lsp"], { cwd: root, env: process.env, stdio: "pipe" }),
      initializationOptions: { enable: true, lint: true },
    };
  },
};

const VueServer: LspServerInfo = {
  id: "vue",
  name: "vue",
  extensions: [".vue"],
  root: nearestRoot(NODE_ROOT_MARKERS),
  languageId: () => "vue",
  async spawn(root) {
    const requireFromRoot = createRequire(join(root, "package.json"));
    const requireFromSelf = createRequire(import.meta.url);
    const serverPath = resolveModule(requireFromRoot, "@vue/language-server/bin/vue-language-server.js")
      ?? resolveModule(requireFromSelf, "@vue/language-server/bin/vue-language-server.js");
    const tsdk = dirname(resolveModule(requireFromRoot, "typescript/lib/tsserverlibrary.js")
      ?? resolveModule(requireFromSelf, "typescript/lib/tsserverlibrary.js")
      ?? "");
    if (!serverPath) return undefined;
    const args = tsdk ? [serverPath, "--stdio", "--tsdk", tsdk] : [serverPath, "--stdio"];
    return {
      process: spawnNodeServer(args, root),
    };
  },
};

const ESLintServer: LspServerInfo = {
  id: "eslint",
  name: "eslint",
  extensions: [...TS_EXTENSIONS, ".vue"],
  root: eslintRoot,
  languageId: languageIdFor,
  async spawn(root, _ctx) {
    const requireFromRoot = createRequire(join(root, "package.json"));
    const requireFromSelf = createRequire(import.meta.url);
    const eslint = resolveModule(requireFromRoot, "eslint");
    if (!eslint) return undefined;
    const serverPath = resolveModule(requireFromRoot, "vscode-langservers-extracted/bin/vscode-eslint-language-server")
      ?? resolveModule(requireFromSelf, "vscode-langservers-extracted/bin/vscode-eslint-language-server");
    if (!serverPath) return undefined;
    return {
      process: spawnNodeServer([serverPath, "--stdio"], root),
    };
  },
  configuration: (root, items) => items.map(() => eslintConfiguration(root)),
};

const OxlintServer: LspServerInfo = {
  id: "oxlint",
  name: "oxlint",
  extensions: [...TS_EXTENSIONS, ".vue", ".astro", ".svelte"],
  root: nearestRoot([".oxlintrc.json", ...NODE_ROOT_MARKERS]),
  languageId: languageIdFor,
  async spawn(root) {
    const oxlint = await findExecutable("oxlint", [root]);
    if (!oxlint || !(await supportsArg(oxlint, "--lsp"))) return undefined;
    return {
      process: spawn(oxlint, ["--lsp"], { cwd: root, env: process.env, stdio: "pipe" }),
    };
  },
};

const BUILTIN_SERVERS: LspServerInfo[] = [DenoServer, TypeScriptServer, VueServer, ESLintServer, OxlintServer];

function customServers(config: LspConfig | undefined): LspServerInfo[] {
  return customLspServerEntries(config).map(([id, server]) => ({
    id,
    name: id,
    extensions: server.extensions ?? [],
    root: customRoot(server.rootMarkers),
    languageId: () => server.languageId ?? id,
    async spawn(root) {
      const command = server.command;
      if (!command?.length) return undefined;
      return {
        process: spawn(command[0]!, command.slice(1), {
          cwd: root,
          env: { ...process.env, ...(server.env ?? {}) },
          stdio: "pipe",
        }),
        initializationOptions: server.initializationOptions,
      };
    },
  }));
}

function customRoot(rootMarkers?: string[]) {
  return async (file: string, ctx: LspServerContext): Promise<string | undefined> => {
    if (!rootMarkers?.length) return ctx.cwd;
    const marker = await findUp(dirname(file), ctx.cwd, rootMarkers);
    return marker ? dirname(marker) : undefined;
  };
}

function nearestRoot(includeMarkers: string[], excludeMarkers: string[] = []) {
  return async (file: string, ctx: LspServerContext): Promise<string | undefined> => {
    if (excludeMarkers.length && await findUp(dirname(file), ctx.cwd, excludeMarkers)) return undefined;
    const marker = await findUp(dirname(file), ctx.cwd, includeMarkers);
    return marker ? dirname(marker) : ctx.cwd;
  };
}

async function denoRoot(file: string, ctx: LspServerContext): Promise<string | undefined> {
  const marker = await findUp(dirname(file), ctx.cwd, DENO_ROOT_MARKERS);
  return marker ? dirname(marker) : undefined;
}

async function eslintRoot(file: string, ctx: LspServerContext): Promise<string | undefined> {
  const root = await nearestRoot(NODE_ROOT_MARKERS)(file, ctx);
  if (!root) return undefined;
  const config = await findUp(dirname(file), root, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ]);
  return config ? root : undefined;
}

async function findUp(start: string, stop: string, markers: string[]): Promise<string | undefined> {
  let dir = start;
  while (true) {
    for (const marker of markers) {
      const target = join(dir, marker);
      try {
        await access(target);
        return target;
      } catch {
        // keep searching
      }
    }
    if (dir === stop || dir === dirname(dir)) return undefined;
    dir = dirname(dir);
  }
}

function resolveModule(requireFn: NodeJS.Require, modulePath: string): string | undefined {
  try {
    return requireFn.resolve(modulePath);
  } catch {
    return undefined;
  }
}

async function findExecutable(command: string, roots: string[]): Promise<string | undefined> {
  const ext = process.platform === "win32" ? ".cmd" : "";
  for (const root of roots) {
    const local = join(root, "node_modules", ".bin", command + ext);
    try {
      await access(local);
      return local;
    } catch {
      // try next location
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const target = join(dir, command + ext);
    try {
      await access(target);
      return target;
    } catch {
      // try next PATH entry
    }
  }
  return undefined;
}

async function supportsArg(binary: string, arg: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFile(binary, ["--help"], { timeout: 3000 });
    return `${stdout}\n${stderr}`.includes(arg);
  } catch {
    return false;
  }
}

function languageIdFor(file: string): string {
  switch (extname(file)) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    case ".vue":
      return "vue";
    default:
      return "javascript";
  }
}

function normalizeLspResult(result: unknown): unknown[] {
  if (!result) return [];
  return Array.isArray(result) ? result.filter(Boolean) : [result];
}

function eslintConfiguration(root: string): Record<string, unknown> {
  return {
    validate: "on",
    packageManager: packageManagerFor(root),
    useESLintClass: false,
    experimental: { useFlatConfig: false },
    codeAction: {
      disableRuleComment: { enable: true, location: "separateLine" },
      showDocumentation: { enable: true },
    },
    codeActionOnSave: { enable: false, mode: "all" },
    format: false,
    nodePath: null,
    onIgnoredFiles: "off",
    options: {},
    problems: { shortenToSingleLine: false },
    quiet: false,
    rulesCustomizations: [],
    run: "onType",
    workingDirectory: { mode: "location" },
  };
}

function packageManagerFor(root: string): string {
  return root.includes("pnpm") ? "pnpm" : "npm";
}
