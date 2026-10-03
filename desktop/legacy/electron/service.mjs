import { randomUUID } from "node:crypto";

/** UI-independent desktop host. The SDK remains the only owner of agent execution. */
export class DesktopService {
  constructor(sdk, emit, getModels) {
    this.sdk = sdk;
    this.emit = emit;
    this.getModels = getModels;
    this.runs = new Map();
    this.pending = new Map();
    this.created = new Map();
    this.traceTurns = new Map();
  }
  sessions() {
    const persisted = this.sdk.listSessions();
    for (const session of persisted) this.created.delete(session.name);
    return [...persisted, ...this.created.values()].map(
      ({ file, ...session }) => ({
        ...session,
        active: this.runs.has(session.name),
      }),
    );
  }
  snapshot(sessionId) {
    const run = this.runs.get(sessionId);
    return {
      history: run?.history ?? this.sdk.getHistory(sessionId),
      events: run?.events ?? [],
      active: !!run,
      turn: run?.turn,
      turns: this.traceTurns.get(sessionId) ?? [],
      interactions: [...this.pending.values()]
        .filter((p) => p.sessionId === sessionId)
        .map(({ resolve, ...p }) => p),
    };
  }
  ask(sessionId, kind, payload) {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, { id, sessionId, kind, payload, resolve });
      this.emit({ type: "interaction", id, sessionId, kind, payload });
    });
  }
  reply(id, value) {
    const request = this.pending.get(id);
    if (!request) throw new Error("此请求已结束。");
    if (
      request.kind === "approval" &&
      !["approve", "reject"].includes(value?.action)
    )
      throw new Error("无效的审批结果");
    if (request.kind === "plan" && typeof value !== "boolean")
      throw new Error("无效的计划审批");
    if (
      request.kind === "question" &&
      value !== null &&
      (!Array.isArray(value) ||
        value.length !== request.payload.questions.length ||
        value.some(
          (a) => !Array.isArray(a) || a.some((v) => typeof v !== "string"),
        ))
    )
      throw new Error("无效的回答");
    this.pending.delete(id);
    request.resolve(value);
    this.emit({ type: "interaction_closed", sessionId: request.sessionId, id });
    return true;
  }
  settle(sessionId) {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId)
        this.reply(
          p.id,
          p.kind === "approval"
            ? { action: "reject" }
            : p.kind === "plan"
              ? false
              : null,
        );
    }
  }
  async run(sessionId, options) {
    if (this.runs.has(sessionId))
      throw new Error("此任务正在运行，请先停止当前回复。");
    if (
      typeof options.prompt !== "string" ||
      !options.prompt.trim() ||
      options.prompt.length > 200000
    )
      throw new Error("请输入有效的消息（不超过 200,000 字符）。");
    if (
      !this.created.has(sessionId) &&
      !this.sdk.listSessions().some((s) => s.name === sessionId)
    )
      throw new Error("任务不存在");
    if (!["default", "plan"].includes(options.mode ?? "default"))
      throw new Error("不支持此权限模式");
    const run = {
      history: this.sdk.getHistory(sessionId),
      events: [],
      turn: { startedAt: Date.now(), outcome: "running" },
    };
    this.runs.set(sessionId, run);
    run.history = [...run.history, { role: "user", content: options.prompt }];
    run.userIndex =
      run.history.filter((message) => message.role === "user").length - 1;
    this.emit({
      type: "started",
      sessionId,
      snapshot: this.snapshot(sessionId),
    });
    // Never return the turn promise through RPC: approvals must remain serviceable.
    run.done = this.consume(sessionId, run, options);
    return true;
  }
  async consume(sessionId, run, options) {
    try {
      const stream = this.sdk.runTurn(sessionId, {
        prompt: options.prompt,
        model: options.model || undefined,
        mode: options.mode ?? "default",
        thinkingLevel: options.thinkingLevel || undefined,
        onApproval: (payload) => this.ask(sessionId, "approval", payload),
        onQuestion: (payload) => this.ask(sessionId, "question", payload),
        onPlanApproval: (payload) => this.ask(sessionId, "plan", payload),
        onStart: (info) =>
          this.emit({ type: "configuration", sessionId, info }),
      });
      for await (const event of stream) {
        const timedEvent = { ...event, at: Date.now() };
        run.events.push(timedEvent);
        this.emit({ type: "agent", sessionId, event: timedEvent });
      }
    } catch (error) {
      run.failed = true;
      if (!run.cancelled) {
        this.emit({
          type: "failure",
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      run.turn = {
        ...run.turn,
        endedAt: Date.now(),
        outcome: run.cancelled
          ? "cancelled"
          : run.failed
            ? "failed"
            : "completed",
      };
      this.traceTurns.set(sessionId, [
        ...(this.traceTurns.get(sessionId) ?? []).filter(
          (turn) => turn.userIndex !== run.userIndex,
        ),
        { userIndex: run.userIndex, ...run.turn },
      ]);
      this.settle(sessionId);
      this.runs.delete(sessionId);
      this.emit({
        type: "finished",
        sessionId,
        snapshot: this.snapshot(sessionId),
        turn: run.turn,
      });
    }
  }
  stop(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) run.cancelled = true;
    this.sdk.stop(sessionId, { cancelQueued: true });
    this.settle(sessionId);
    return true;
  }
  async call(method, params) {
    switch (method) {
      case "bootstrap":
        return {
          sessions: this.sessions(),
          config: this.sdk.getModelConfig(),
          models: await this.getModels(),
        };
      case "sessions":
        return this.sessions();
      case "snapshot":
        return this.snapshot(params.sessionId);
      case "create": {
        const ref = this.sdk.createSession({ cwd: params.cwd });
        this.created.set(ref.id, {
          name: ref.id,
          cwd: ref.cwd,
          cwdLabel: ref.cwd,
          title: "新任务",
          preview: "",
          messageCount: 0,
          mtime: Date.now(),
        });
        return ref;
      }
      case "run":
        return this.run(params.sessionId, params);
      case "stop":
        return this.stop(params.sessionId);
      case "reply":
        return this.reply(params.id, params.value);
      default:
        throw new Error("Unknown desktop method");
    }
  }
  async close() {
    const runs = [...this.runs.values()];
    for (const id of this.runs.keys()) this.stop(id);
    await Promise.allSettled(runs.map((run) => run.done));
  }
}
