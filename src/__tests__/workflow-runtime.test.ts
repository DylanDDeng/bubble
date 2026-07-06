import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowAgentSpec } from "../agent/workflow/runtime.js";

// Fake dispatcher: echoes "ok:<prompt>" after a small delay, or fails prompts
// that start with "FAIL". Supports a schema by returning a structured object.
function fakeDispatch(delay = 5) {
  return async (spec: WorkflowAgentSpec) => {
    await new Promise((r) => setTimeout(r, delay));
    if (spec.prompt.startsWith("FAIL")) return { ok: false as const, error: `boom: ${spec.prompt}` };
    if (spec.opts.schema) return { ok: true as const, value: { prompt: spec.prompt, model: spec.opts.model ?? "inherit" } };
    return { ok: true as const, value: `ok:${spec.prompt}` };
  };
}

describe("workflow runtime (option C)", () => {
  it("runs a script and returns its final value", async () => {
    const res = await runWorkflow({
      script: `const a = await agent("hello"); return { a };`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: { a: "ok:hello" } });
  });

  it("exposes args and runs parallel() concurrently (overlap, not serialized)", async () => {
    const start = Date.now();
    const res = await runWorkflow({
      args: ["x", "y", "z"],
      script: `const r = await parallel(args.map(it => () => agent(it))); return r;`,
      dispatchAgent: fakeDispatch(60),
    });
    const elapsed = Date.now() - start;
    expect(res).toEqual({ ok: true, value: ["ok:x", "ok:y", "ok:z"] });
    // 3 × 60ms concurrently should be well under the 180ms serial sum.
    expect(elapsed).toBeLessThan(150);
  });

  it("pipeline() streams items through stages and preserves item order", async () => {
    const res = await runWorkflow({
      args: ["a", "b"],
      script: `return await pipeline(args, it => agent("scout:"+it), prev => agent("verify:"+prev));`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: ["ok:verify:ok:scout:a", "ok:verify:ok:scout:b"] });
  });

  it("parallel() degrades a failed member to null without crashing", async () => {
    const res = await runWorkflow({
      script: `return await parallel([() => agent("ok1"), () => agent("FAIL2"), () => agent("ok3")]);`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: ["ok:ok1", null, "ok:ok3"] });
  });

  it("survives many (>=2) agent failures with try/catch (no VM corruption)", async () => {
    const res = await runWorkflow({
      script: `
        const log = [];
        for (const p of ["FAIL1", "ok2", "FAIL3", "ok4"]) {
          try { log.push("OK:" + await agent(p)); } catch (e) { log.push("CATCH"); }
        }
        return log;`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: ["CATCH", "OK:ok:ok2", "CATCH", "OK:ok:ok4"] });
  });

  it("passes per-call model/effort through to the dispatcher and returns schema objects", async () => {
    const res = await runWorkflow({
      script: `return await agent("classify", { model: "anthropic:claude-opus-4-1", schema: { type: "object" } });`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: { prompt: "classify", model: "anthropic:claude-opus-4-1" } });
  });

  it("strips `export const meta` and still runs the body", async () => {
    const res = await runWorkflow({
      script: `export const meta = { name: "t", description: "d" };\nreturn await agent("go");`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res).toEqual({ ok: true, value: "ok:go" });
  });

  it("exposes a working budget object for budget-aware loops", async () => {
    let spent = 0;
    const res = await runWorkflow({
      script: `
        const out = [];
        while (budget.remaining() > 0) { out.push(await agent("scout" + out.length)); }
        return out.length;`,
      budget: { total: 30, spent: () => spent, remaining: () => Math.max(0, 30 - spent) },
      dispatchAgent: async (spec) => { spent += 10; return { ok: true, value: `ok:${spec.prompt}` }; },
    });
    expect(res).toEqual({ ok: true, value: 3 }); // 3 × 10 tokens exhausts the 30 budget
  });

  it("reports a script syntax error instead of throwing", async () => {
    const res = await runWorkflow({
      script: `return await agent("x" ;;;`,
      dispatchAgent: fakeDispatch(),
    });
    expect(res.ok).toBe(false);
  });
});

describe("workflow runtime — abort with in-flight agents (QuickJS dispose safety)", () => {
  it("aborting mid-flight disposes cleanly and does not poison the wasm module for later runs", async () => {
    // Dispatcher whose promise settles only AFTER the abort fires — the exact
    // shape of a user interrupt while real subagents are still tearing down.
    // Before the fix this leaked the agents' unsettled VM deferreds; vm.dispose()
    // then tripped JS_FreeRuntime's list_empty(&rt->gc_obj_list) assertion and
    // Aborted the process-wide wasm module, so the NEXT workflow failed too.
    const controller = new AbortController();
    let releaseAgents!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAgents = resolve; });
    const slowDispatch = async (spec: WorkflowAgentSpec) => {
      await gate;
      return { ok: true as const, value: `ok:${spec.prompt}` };
    };

    const running = runWorkflow({
      script: `const r = await parallel([() => agent("a"), () => agent("b"), () => agent("c")]); return r;`,
      dispatchAgent: slowDispatch,
      signal: controller.signal,
    });
    // Let the script start its agents, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("user interrupt"));
    const aborted = await running;
    expect(aborted.ok).toBe(false);
    expect((aborted as { ok: false; error: string }).error).toContain("aborted");

    // The stranded dispatches settle after disposal — must be a silent no-op.
    releaseAgents();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The wasm module must still be usable: a fresh workflow runs normally.
    const second = await runWorkflow({
      script: `const a = await agent("hello again"); return a;`,
      dispatchAgent: fakeDispatch(),
    });
    expect(second).toEqual({ ok: true, value: "ok:hello again" });
  });
});
