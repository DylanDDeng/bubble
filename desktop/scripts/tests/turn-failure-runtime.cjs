// Narrow source loader: run current production TS, never stale dist artifacts.
// Extract the COMPLETE startRunner declaration via the TS AST (including its
// actual onMessage/onError wiring). No callback/producer is copied into tests.
// Only desktop peripherals and the external SDK are mocked; SQLite, adapter,
// provider service, agent-loop, persistence policy and stop policy are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');

exports.createRuntime = function createRuntime(profile) {
  const root = path.resolve(__dirname, '../../src/electron');
  const cache = new Map();
  const control = { loadError: null, turnError: null };
  const sdk = {
    getModelConfig: () => ({ providers: [{ id: 'fixture', hasApiKey: true }] }),
    createSession: () => ({ id: require('node:crypto').randomUUID() }),
    listSessions: () => [],
    stop() {},
    async *runTurn() {
      if (control.turnError) throw control.turnError;
    },
  };
  const overrides = new Map([
    [path.join(root, 'util.ts'), { isDev: () => false }],
    [path.join(root, 'libs/runtime/index.ts'), {
      ensureAgentRuntimeRegistry() { throw new Error('Unexpected runtime fallback'); },
      resolveRuntime() { throw new Error('Unexpected runtime fallback'); },
    }],
    [path.join(root, 'libs/bubble-settings.ts'), {
      getBubbleModelConfig: async () => ({ defaultModel: 'fixture:model', options: ['fixture:model'] }),
    }],
    [path.join(root, 'libs/provider/bubble-sdk-loader.ts'), {
      getBubbleSdk: async () => { if (control.loadError) throw control.loadError; return sdk; },
      getBubbleSessionManager: async () => { throw new Error('Unexpected real history access'); },
    }],
  ]);
  const shell = { app: { getPath: () => profile, getAppPath: () => root, isPackaged: false } };
  function compile(source, filename) {
    return ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
  }
  function resolveLocal(request, filename) {
    const base = path.resolve(path.dirname(filename), request);
    const candidates = [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')];
    const found = candidates.find(file => overrides.has(file) || (fs.existsSync(file) && fs.statSync(file).isFile()));
    assert.ok(found, `Cannot resolve ${request} from ${filename}`);
    return found;
  }
  function loadFile(filename) {
    if (overrides.has(filename)) return overrides.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const localRequire = Module.createRequire(filename);
    const requireDependency = request => {
      if (request === 'electron') return shell;
      if (request.startsWith('.')) return loadFile(resolveLocal(request, filename));
      return localRequire(request);
    };
    const code = compile(fs.readFileSync(filename, 'utf8'), filename);
    vm.runInThisContext(Module.wrap(code), { filename })(mod.exports, requireDependency, mod, filename, path.dirname(filename));
    return mod.exports;
  }
  const load = relative => loadFile(path.join(root, relative));
  const sessions = load('libs/session-store.ts');
  const agentLoop = load('libs/agent-loop.ts');
  const service = load('libs/provider/service.ts').getProviderService();
  const filename = path.join(root, 'ipc-handlers.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = [
    'startRunner', 'normalizeModel', 'normalizeProviderModel', 'normalizeSessionScope',
    'normalizeBubblePermissionMode', 'createAgentRunId', 'withAgentAttribution',
    'shouldPersistProviderMessage', 'extractAssistantText', 'detectLocalRunnerFailureMessage',
    'isTwoPhaseStopProvider', 'stopStateOf', 'clearStopFallbackTimer',
  ];
  const declarations = names.map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1, `Expected one complete production declaration: ${name}`);
    return nodes[0].getText(ast);
  });
  const runnerHandles = new Map();
  const callbacks = [];
  const broadcasts = [];
  const context = {
    console, Date, Error, setTimeout, clearTimeout,
    uuidv4: require('node:crypto').randomUUID,
    sessions, runnerHandles,
    userStoppedRunnerHandles: new WeakSet(), stoppingCodexSessions: new Map(),
    runAgentLoop: options => { callbacks.push(options); return agentLoop.runAgentLoop(options); },
    ...load('libs/claude-stop-reconcile.ts'),
    ...load('libs/claude-model-selection.ts'),
    isDev: () => false,
    getSessionState: () => ({ pendingPermissions: new Map() }),
    getDelegateMirrorTarget: () => null,
    isDelegateExecutionSession: () => false,
    // Match Electron IPC's structured-clone boundary (also removes VM prototypes).
    broadcast: (_window, event) => broadcasts.push(structuredClone(event)),
    feishuBridge: { handleSessionMessage() {}, handleRunnerError() {} },
  };
  vm.createContext(context);
  vm.runInContext(compile(declarations.join('\n'), filename), context, { filename });
  return { load, startRunner: context.startRunner, runnerHandles, callbacks, broadcasts, service, control };
};
