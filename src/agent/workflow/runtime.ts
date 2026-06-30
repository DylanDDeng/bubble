/**
 * Workflow runtime (option C) — executes an LLM-authored JS orchestration
 * script in a QuickJS-wasm sandbox and returns its final value.
 *
 * Engine decision (proven empirically, node + bun): the SYNC variant with a
 * `newPromise` deferred-promise bridge — NOT asyncify. Asyncify serializes
 * parallel() and corrupts the VM on the 2nd agent failure; the sync+newPromise
 * bridge gives true concurrency AND clean error propagation across many
 * failures. The host drives the VM job queue via executePendingJobs().
 *
 * The script's only capability is agent(); it has no fs/shell/net/clock/RNG
 * (determinism gating below). parallel/pipeline/phase/log/budget are a JS
 * prelude over the single host function __agent plus a few host callbacks.
 */

import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";

export interface WorkflowAgentOpts {
  model?: string;
  effort?: string;
  category?: string;
  agentType?: string;
  schema?: unknown;
  label?: string;
  phase?: string;
  isolation?: string;
}

export interface WorkflowAgentSpec {
  prompt: string;
  opts: WorkflowAgentOpts;
}

export type AgentDispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface RunWorkflowOptions {
  script: string;
  args?: unknown;
  /** Dispatches one agent() call; resolves with its result or a failure. */
  dispatchAgent: (spec: WorkflowAgentSpec) => Promise<AgentDispatchResult>;
  onPhase?: (title: string) => void;
  onLog?: (message: string) => void;
  budget?: { total: number | null; spent: () => number; remaining: () => number };
  signal?: AbortSignal;
  /** Hard cap on total agent() calls per run (runaway backstop). */
  maxAgents?: number;
  /** Per-script-compute deadline for the interrupt handler (ms). */
  computeDeadlineMs?: number;
}

export type RunWorkflowResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Async semaphore bounding how many workflow agents run concurrently — kept
 * below the global scheduler cap so interactive subagents always have slots
 * (option C review M2/M5). Permits are acquired/released only around a leaf
 * agent dispatch, never across parallel/pipeline composition (no deadlock).
 */
export class WorkflowConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly capacity: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const DEFAULT_MAX_AGENTS = 1000;
const DEFAULT_COMPUTE_DEADLINE_MS = 10_000;

// JS prelude evaluated before the user script: defines the script API in terms
// of the minimal host surface (__agent / __phase / __log / __budget*).
const PRELUDE = `
globalThis.agent = async (prompt, opts) => {
  const raw = await __agent(JSON.stringify({ prompt: String(prompt ?? ""), opts: opts || {} }));
  return JSON.parse(raw);
};
globalThis.parallel = (thunks) => Promise.all((thunks || []).map((t) => {
  try { return Promise.resolve(t()).catch(() => null); } catch (_e) { return Promise.resolve(null); }
}));
globalThis.pipeline = (items, ...stages) => Promise.all((items || []).map(async (item, i) => {
  let v = item;
  for (const stage of stages) {
    try { v = await stage(v, item, i); } catch (_e) { return null; }
  }
  return v;
}));
globalThis.phase = (t) => __phase(String(t ?? ""));
globalThis.log = (m) => __log(String(m ?? ""));
globalThis.budget = {
  get total() { return __budgetTotal(); },
  spent() { return __budgetSpent(); },
  remaining() { return __budgetRemaining(); },
};
`;

/** Removes ambient nondeterminism so a run is reproducible (design §4.3). */
const DETERMINISM_GATING = `
delete globalThis.Date;
delete globalThis.WeakRef;
delete globalThis.FinalizationRegistry;
Math.random = () => { throw new Error("Math.random is disabled in workflows (nondeterministic)"); };
`;

/** Turns `export const meta = …` / `export function …` into plain declarations. */
function stripExports(script: string): string {
  return script.replace(/(^|\n)\s*export\s+(const|let|var|function|class|async)\b/g, "$1$2");
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  const pending = new Set<Promise<void>>();
  const state = { disposed: false };
  let agentCount = 0;
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;

  // Per-compute deadline: only counts VM bytecode time, reset on each pump so a
  // long run that is mostly waiting on agents is not killed.
  let computeStart = Date.now();
  const computeDeadline = options.computeDeadlineMs ?? DEFAULT_COMPUTE_DEADLINE_MS;
  vm.runtime.setInterruptHandler(() => Date.now() - computeStart > computeDeadline);

  try {
    vm.unwrapResult(vm.evalCode(DETERMINISM_GATING)).dispose();

    installHostFunctions(vm, options, pending, () => agentCount, () => { agentCount += 1; }, maxAgents, state);

    // args as a deterministic injected global.
    const argsJson = JSON.stringify(options.args ?? null);
    vm.unwrapResult(vm.evalCode(`globalThis.args = ${argsJson};`)).dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE)).dispose();

    const body = stripExports(options.script);
    const wrapped = [
      "globalThis.__wfdone = false; globalThis.__wfresult = null; globalThis.__wferror = null;",
      "(async () => {",
      body,
      "})().then(",
      "  (r) => { globalThis.__wfresult = r === undefined ? null : r; globalThis.__wfdone = true; },",
      "  (e) => { globalThis.__wferror = (e && e.message) ? String(e.message) : String(e); globalThis.__wfdone = true; }",
      ");",
    ].join("\n");

    computeStart = Date.now();
    const evalResult = vm.evalCode(wrapped);
    if (evalResult.error) {
      const message = vm.dump(evalResult.error);
      evalResult.error.dispose();
      return { ok: false, error: `workflow script error: ${formatError(message)}` };
    }
    evalResult.value.dispose();

    // Drive the VM job queue interleaved with host agent settlements.
    const isDone = (): boolean => {
      const h = vm.getProp(vm.global, "__wfdone");
      const done = vm.dump(h) === true;
      h.dispose();
      return done;
    };

    while (!isDone()) {
      if (options.signal?.aborted) {
        return { ok: false, error: "workflow aborted" };
      }
      computeStart = Date.now();
      vm.runtime.executePendingJobs();
      if (isDone()) break;
      if (pending.size === 0) {
        if (!vm.runtime.hasPendingJob || !vm.runtime.hasPendingJob()) break; // settled or stalled
        continue;
      }
      await Promise.race([...pending, abortRace(options.signal)]);
    }

    const errH = vm.getProp(vm.global, "__wferror");
    const err = vm.dump(errH);
    errH.dispose();
    if (err != null && err !== "") {
      return { ok: false, error: String(err) };
    }
    const resH = vm.getProp(vm.global, "__wfresult");
    const value = vm.dump(resH);
    resH.dispose();
    return { ok: true, value };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    state.disposed = true;
    vm.dispose();
  }
}

function abortRace(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {}); // never settles
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function installHostFunctions(
  vm: QuickJSContext,
  options: RunWorkflowOptions,
  pending: Set<Promise<void>>,
  getCount: () => number,
  bumpCount: () => void,
  maxAgents: number,
  state: { disposed: boolean },
): void {
  vm.newFunction("__agent", (specHandle) => {
    const spec = JSON.parse(vm.getString(specHandle)) as WorkflowAgentSpec;
    const deferred = vm.newPromise();
    // Settling the VM promise touches the context, which may have been disposed
    // if the run was aborted while host work was still in flight — guard it.
    const settle = (fn: () => void): void => {
      if (state.disposed) return;
      try { fn(); } catch { /* VM disposed mid-settle */ }
    };
    if (getCount() >= maxAgents) {
      const e = vm.newString(`workflow exceeded the ${maxAgents}-agent cap`);
      deferred.reject(e);
      e.dispose();
    } else {
      bumpCount();
      const p = options.dispatchAgent(spec).then(
        (res) => settle(() => {
          if (res.ok) {
            const v = vm.newString(JSON.stringify(res.value ?? null));
            deferred.resolve(v);
            v.dispose();
          } else {
            const e = vm.newString(res.error);
            deferred.reject(e);
            e.dispose();
          }
        }),
        (err) => settle(() => {
          const e = vm.newString(err?.message || String(err));
          deferred.reject(e);
          e.dispose();
        }),
      ).finally(() => { pending.delete(p); });
      pending.add(p);
    }
    deferred.settled.then(() => { if (!state.disposed) try { vm.runtime.executePendingJobs(); } catch { /* disposed */ } });
    return deferred.handle;
  }).consume((f) => vm.setProp(vm.global, "__agent", f));

  vm.newFunction("__phase", (h) => {
    options.onPhase?.(vm.getString(h));
    return vm.undefined;
  }).consume((f) => vm.setProp(vm.global, "__phase", f));

  vm.newFunction("__log", (h) => {
    options.onLog?.(vm.getString(h));
    return vm.undefined;
  }).consume((f) => vm.setProp(vm.global, "__log", f));

  vm.newFunction("__budgetTotal", () => {
    const total = options.budget?.total ?? null;
    return total === null ? vm.null : vm.newNumber(total);
  }).consume((f) => vm.setProp(vm.global, "__budgetTotal", f));

  vm.newFunction("__budgetSpent", () => vm.newNumber(options.budget?.spent() ?? 0))
    .consume((f) => vm.setProp(vm.global, "__budgetSpent", f));

  vm.newFunction("__budgetRemaining", () => {
    const remaining = options.budget?.remaining() ?? Number.POSITIVE_INFINITY;
    return vm.newNumber(Number.isFinite(remaining) ? remaining : Number.MAX_SAFE_INTEGER);
  }).consume((f) => vm.setProp(vm.global, "__budgetRemaining", f));
}

function formatError(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return String(value);
}
