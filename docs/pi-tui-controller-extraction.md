# BubbleTuiController 抽取详细设计（Phase 3 · 框架无关运行时控制器）

Status: approved; implementation in progress
Source of truth for Phase 3 of docs/pi-tui-rewrite-design.md (§8).
All line numbers verified against `rewrite/pi-tui` at commit `c7b8553`.

## 0. 现状诊断

`App` 组件（src/tui-ink/app.tsx:205，2960 行）把四类职责压在同一批 React 闭包里：

1. **状态**：约 38 个 `useState` + 25 个 `useRef`（app.tsx:206-420 主声明区，另有 9 个散落在 789/1360/2222-2225/2326/2351-2353）；
2. **事件归约**：`for await` 事件循环内的 `switch (event.type)`（app.tsx:1657-1854），依赖约 10 个闭包可变量（app.tsx:1505-1512）；
3. **副作用编排**：40ms 流式 flush（app-helpers.ts:146、app.tsx:1541-1565）、queue drain、goal 续跑、loop 定时器、task wake 合流；
4. **渲染策略耦合**：`reprintTranscript`/`staticGeneration`（app.tsx:362-377）是 Ink `<Static>` 专用机制。

关键事实：现有 27 个 `ink-*.test.*` 测试没有任何一个挂载 `<App>`（grep 验证：全部只导入纯模块/子组件；`ink-goal.test.ts` 仅导入 app.tsx 的 re-export 与 run.tsx 的 `createInkAppElement`）。抽取不必触碰 app.tsx 也能保测试绿。

## 1. BubbleTuiSnapshot 字段清单

### 1.1 归入控制器状态（`state.ts` 持有，快照暴露）

**会话与运行时绑定**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `sessionManager` | app.tsx:206 | `sessionFile`、`sessionTitle`（投影，不暴露 manager 实例） |
| `externalRuntimeBinding` | app.tsx:207 | `binding`（`{id,sessionId,modelId,reasoningEffort}` 或 undefined） |
| `externalRuntimeGenerationRef` | app.tsx:390 | 内部计数器，不进快照（stale 事件隔离） |

**转录与流式**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `messages` | app.tsx:242 | `messages: readonly DisplayMessage[]` |
| `isRunning` | app.tsx:244 | `run.active` |
| `streamingContent/Reasoning/Tools/Parts` | app.tsx:245-248 | `run.tail.{content,reasoning,tools,parts}` |
| `runStartRef` | app.tsx:408 | `run.startedAt` |
| `liveSubagentToolsRef` | app.tsx:254 | `subagents.liveTools`（投影 `DisplayToolCall[]`） |
| `compaction` | app.tsx:279 | `compaction: CompactionProgress \| null` |
| `staticGeneration` | app.tsx:362 | 改造为 `transcriptEpoch: number`（渲染无关事实；Ink 适配层映射回 `<Static>` key，pi-tui 映射为全量重绘触发） |

**输入队列 / steer**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `pendingSteersRef` + `pendingSteerCount` | app.tsx:381,383 | `run.pendingSteerCount`（Map 内部持有） |
| `queuedInputsRef` + `queuedCount` | app.tsx:382,384 | `run.queuedCount` |
| `inputControllerRef` | app.tsx:380 | 内部 |
| `startingSubmitFingerprint`(ref+state) | app.tsx:385-386 | 内部（submit 去重门） |
| `nextRunIdRef` | app.tsx:387 | 内部 |

**阻塞交互与覆盖层**

| 现状 | 行号 | 快照字段（`snapshot.overlay`） |
|---|---|---|
| `pendingPlan` | app.tsx:327 | `overlay.plan?: { id, plan }` |
| `pendingApproval` | app.tsx:331 | `overlay.approval?: { id, request }` |
| `pendingQuestion` | app.tsx:335 | `overlay.question?: { id, request }` |
| `pendingFeedback` | app.tsx:336 | `overlay.feedback?: {...}` |
| `pickerMode` | app.tsx:340 | `overlay.picker: PickerMode \| null` |
| `grokModels` | app.tsx:341 | `overlay.grokModels` |
| `statsPanel` | app.tsx:342 | `overlay.stats?: { range, bundle }` |
| `keyProviderId` | app.tsx:345 | `overlay.keyProviderId` |

**运行配置与视图偏好**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `thinkingLevel` | app.tsx:284 | `model.thinkingLevel` |
| `permissionMode` | app.tsx:285 | `model.permissionMode` |
| `showThinking` / `verboseTrace` | app.tsx:346-347 | `viewFlags.{showThinking,verboseTrace}` |
| `themeMode` + `themePickerRevertRef` | app.tsx:214,239 | `viewFlags.themeMode` + 内部 revert 点 |
| `goalLine` | app.tsx:286 | `goal.line` |
| `branch` | app.tsx:287 | `footer.branch` |
| `contextUsage` | app.tsx:288 | `footer.contextUsage` |
| `currentUpdateNotice` | app.tsx:326 | `welcome.updateNotice` |

**任务 / 循环 / 生命周期**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `taskSnapshot` | app.tsx:401 | `tasks: readonly BackgroundTaskInfo[]` |
| `taskOwnerSessionsRef` / `pendingTaskCompletionsRef` | app.tsx:2222,2224 | 内部（§4.4 事务数据） |
| `taskWakeCoalescerRef` | app.tsx:2225 | 内部（经 ports.scheduler） |
| `loopsRef` / `nextLoopIdRef` | app.tsx:2351-2352 | `loops: readonly LoopState[]` |
| `orphanProbeDoneRef` | app.tsx:2326 | 内部一次性门 |
| `exitRequestedRef` | app.tsx:356 | `lifecycle.exitRequested` |
| `isExiting` | app.tsx:395 | `lifecycle.phase` |
| `sessionStartRef` | app.tsx:357 | 内部（`shutdown()` 计算 `TuiExitSummary.wallMs`） |
| `subagentEntryFocused` | app.tsx:274 | `focus: "composer" \| "subagent-entry"` |

**Composer 桥接**

| 现状 | 行号 | 快照字段 |
|---|---|---|
| `composerDraft` | app.tsx:344 | `composer.draft: { text, epoch } \| null` |
| `nextImageDisplayLabelStartRef` | app.tsx:243 | `composer.nextImageLabelStart` |

### 1.2 不进控制器的渲染器专属状态

- `autoResolved`（app.tsx:219）：host 启动期探测常量，作控制器构造入参；
- `nowTick`（app.tsx:398）：渲染端 1Hz 时钟；
- `cursorResetEpoch`（app.tsx:343）：Ink InputBox workaround，新 composer 自管；
- `terminalColumns/Rows`：渲染器事件（设计文档 §8.3）；
- `didMountSizeRef`/`showWelcomeRef`/`startedWithVisibleHistoryRef`：并入一次性 `welcome.visible` 投影输入；
- React 闭包镜像类 ref（`sessionManagerRef`:210 等 5 个）：类字段天然消除。

### 1.3 快照签名

```ts
export interface BubbleTuiSnapshot {
  readonly version: number;                 // 单调递增，供行缓存失效
  readonly session: { file: string; title?: string; displayName: string };
  readonly externalRuntime: {
    readonly kind: "none" | "grok" | "unsupported";
    readonly binding?: ExternalRuntimeBinding;
  };
  readonly messages: readonly DisplayMessage[];
  readonly transcriptEpoch: number;
  readonly run: RunSnapshot | null;
  readonly overlay: OverlaySnapshot;
  readonly model: { id: string; label: string; thinkingLevel: ThinkingLevel; permissionMode: PermissionMode };
  readonly viewFlags: { showThinking: boolean; verboseTrace: boolean; themeMode: ThemeMode };
  readonly goal: { line: string };
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly loops: readonly LoopState[];
  readonly subagents: { groups: SubagentGroup[] };
  readonly focus: "composer" | "subagent-entry";
  readonly composer: { draft: { text: string; epoch: number } | null; nextImageLabelStart: number };
  readonly welcome: { visible: boolean; updateNotice?: string };
  readonly footer: { branch?: string; contextUsage: string };
  readonly compaction: CompactionProgress | null;
  readonly lifecycle: { phase: "running" | "exiting" };
}

export interface RunSnapshot {
  readonly active: boolean;
  readonly startedAt: number | null;
  readonly tail: {
    readonly content: string; readonly reasoning: string;
    readonly tools: readonly DisplayToolCall[]; readonly parts: readonly DisplayMessagePart[];
  };
  readonly pendingSteerCount: number;
  readonly queuedCount: number;
}
```

`DisplayMessage` 沿用 `tui-ink/display-history.ts`（含 `key`/`syntheticKind`/`systemFingerprint`）形态，但先迁至 `src/tui/model/display-history.ts`（§5）；`reconstructDisplayMessages`（app.tsx:104 re-export）随迁。

## 2. Agent 事件 reducer 抽取（app.tsx:1657-1854）

把 `switch (event.type)` 及其闭包累积器改为**纯转换 + 效果列表**：reducer 不调用任何 `setState`/`sessionManager.appendMessage`/`externalRuntime.cancel`，只返回下一状态与 `ControllerEffect[]`。

```ts
export interface RunAccumulator {
  readonly runId: number;
  content: string;
  reasoning: string;
  systemFingerprint?: string;
  toolCalls: DisplayToolCall[];        // copy-on-write
  parts: DisplayMessagePart[];
  usageTokens: number;
  usageReported: boolean;
}

export type RunOutcome = "running" | "cancelled" | "errored";

export interface RunState {
  readonly accumulator: RunAccumulator;
  readonly dirty: { content: boolean; reasoning: boolean; parts: boolean; tools: boolean };
  readonly outcome: RunOutcome;
}

export interface RunContext {
  readonly external: boolean;
  readonly externalModelId?: string;
  isCurrentRun(): boolean;
  now(): number;
  readonly runStartedAt: number | null;
}

export interface EventReduceResult {
  readonly state: RunState;
  readonly effects: readonly ControllerEffect[];
}

export function reduceAgentEvent(state: RunState, event: AgentEvent, ctx: RunContext): EventReduceResult;
export function reduceRunFinish(state: RunState, opts: {
  cancelled: boolean; errored: boolean; leftoverSteers: AgentRunInput[];
}, ctx: RunContext): EventReduceResult;
```

各 case 语义逐条等价（迁移期禁止顺手重构）：

- `turn_start`（1658-1666）→ `{kind:"stream-cleared"}`（丢弃半成品重试缓冲）；
- `text_delta`/`reasoning_delta` → 只置 `dirty.*`，不发即时效果；
- `tool_call_start/delta/tool_start/tool_end/tool_update`（1681-1770）→ 不可变更新 `toolCalls` + `{kind:"tools-updated"}`（工具事件保持即时 flush）；`parsePartialArgs` 继续用 app-helpers.ts:103；
- `tool_update` 落空分支（1741-1753）→ 命中 `accumulateLiveSubagentUpdate` 时发 `{kind:"live-subagent-changed"}`；
- `mode_changed`（1755-1758）→ `{kind:"permission-mode-changed", mode}`；
- `turn_end`（1826-1841）→ `willContinue` 分支：`{kind:"assistant-committed"}`（不带 elapsed）+ `{kind:"stream-cleared"}`；终局分支带 `taskElapsedMs`（取 `ctx.runStartedAt`）。

Grok 策略预过滤（1640-1656：白名单外 → `externalRuntime.cancel` + 抛 `GrokRuntimeError("policy_violation")`）改为 reducer 前置守卫，输出 `{kind:"external-cancel", sessionId}` + `{kind:"run-error", error}`。

异常路径（1855-1887）：stale 外部 run 不 commit；用户取消在多路复用终端走全量重印——reducer 不能读 agent，建模为 `{kind:"transcript-rebuild-from-agent", fullReprint: boolean}`，`fullReprint` 由 ports 的 `isMultiplexed()` 决定。

### 2.2 40ms streaming flush

flush 是调度策略，留在控制器，不进纯 reducer：

```ts
export interface FlushScheduler {
  scheduleFlush(intervalMs: number, flush: () => void): void;   // 已有 pending 则合并
  cancelFlush(): void;                                          // clearAssistantStream 前必须取消
}
```

`STREAMING_FLUSH_INTERVAL_MS = 40` 常量迁入 controller 层共享模块；`stream-cleared`/run 终结效果先 `cancelFlush()` 再清 tail，防“定时器复活已提交文本”。测试注入假定时器即可确定性断言 25fps 合并行为。

### 2.3 pending steer / queue 状态机

```text
queued ──(submit while running & steerEligible)──▶ steering(pending_steer)
steering ──input_applied──▶ applied(行移到队尾, 出live区)
steering ──input_rejected──▶ queued(badge翻转, 保留行)          [1791-1806]
steering ──run cancel + leftover──▶ dropped(行删除)              [1904-1908]
steering ──run 正常结束 + leftover──▶ queued(重排队)
queued  ──drainQueuedInput──▶ submitted(删占位行, 重新走 submit)  [2422-2435]
any    ──session switch──▶ purged                                [989-995]
```

```ts
export interface InputQueueState {
  queued: QueuedInput[];
  pendingSteers: Map<string, PendingSteerMeta>;
}
export function reduceInputQueueEvent(
  state: InputQueueState, event: AgentEvent, ctx: { runSessionFile?: string },
): { state: InputQueueState; effects: readonly ControllerEffect[] };
export function drainNextQueued(
  state: InputQueueState, gate: QueueDrainGate,
): { state: InputQueueState; submit?: QueuedInput };
// gate = { runActive, startingSubmit, overlayOpen, currentSessionFile }
```

`input_applied` 的多路复用分支（1768-1789：tmux 下必须全量重印否则留空带）产出 `{kind:"transcript-move-message", displayKey, fullReprint}`——Ink 特定的选择下沉为效果参数。

`input_pending_changed`（1808-1813）：`pending===0` 时清空 Map 并对齐计数。

## 3. 阻塞式交互 Promise 生命周期（app.tsx:542-583）

```ts
export type OverlayTerminalState = "accepted" | "rejected" | "cancelled" | "disposed";
export type SettleVia = "user" | "session-switch" | "shutdown" | "replaced";

export interface OwnedRequest<TDecision> {
  readonly id: string;
  readonly kind: "plan" | "approval" | "question" | "feedback";
  state: "pending" | OverlayTerminalState;
  readonly result: Promise<TDecision>;
  settle(decision: TDecision, via: SettleVia): boolean;   // 幂等
}

export class OverlayRequestController {
  constructor(deps: { questionController?: QuestionController; onSettled(): void });
  installPlanHandler(ref: PlanHandlerRef): void;
  installApprovalHandler(ref: ApprovalHandlerRef): void;
  adoptQuestionStream(): void;
  openFeedback(base: FeedbackBase, initialDescription: string): OwnedRequest<"dismissed">;
  settleAll(via: "session-switch" | "shutdown"): void;
}
```

plan settle：approve→`resolve({action:"approve",plan})`，reject→`resolve({action:"reject",reason})`。question 的 settle 转发 `questionController.reply/reject`。

**终局保证（现状缺口，明确为行为增量）**：现状 `applySessionSwitch`（986-1018）与 `requestExit`（474-541）都不 settle 挂起请求。新控制器必须：

- `switchSession` commit 前 `settleAll("session-switch")`；
- `shutdown()` abort 后立即 `settleAll("shutdown")`；
- overlay 替换路径 settle `"replaced"`；
- 测试断言：任何 teardown 路径后 `OwnedRequest.result` 均已落定。

## 4. Session 切换事务（app.tsx:986-1089 + main.ts:711-759）

### 4.1 两阶段边界

- **prepare（host 侧，可失败）**：main.ts:711-759 的 `switchSession` 闭包——新建 `SessionManager`、读 history、重绑 `agent.messages` 等。含磁盘 IO 与失败分支，保持注入：控制器经 port 调用。
- **commit（controller 侧，原子）**：`applySessionSwitch`（986-1018）的全部清理，单次状态写入、单次 notify。

```ts
export interface SessionHostPort {
  switchSession(file: string): { manager: SessionManager } | { error: string };
  createFresh(cwd: string): SessionManager;
}

export class SessionTransitionController {
  constructor(deps: { host: SessionHostPort; state: ControllerState; ports: BubbleTuiPorts; overlays: OverlayRequestController });
  async switchTo(plan: SessionTransitionPlan): Promise<{ ok: true; manager: SessionManager } | { ok: false; error: string }>;
  async startFresh(metadata?: Partial<SessionMetadata>): Promise<...>;
  async transitionToNative(): Promise<SessionManager | undefined>;
}
```

失败语义保持现状：prepare/外部运行时停止失败 ⇒ 不动旧会话。

### 4.2 commit 清理清单（十二项）

1. `externalRuntimeGenerationRef++`；
2. 收集 `queuedAndPendingDisplayKeys` 并从重建转录过滤占位行；
3. `queuedInputs=[]`、`pendingSteers.clear()`、`inputControllerRef=null`、计数归零；
4. `startingSubmitFingerprint` 置 null（ref+state 双清）；
5. `composerDraft=null`；
6. 绑定新 `sessionManager`；`agent.setSessionID(newFile)`；
7. `externalRuntimeBinding` 从新 metadata 刷新；
8. `clearLiveSubagentTools()` + version bump；
9. 转录重建：`reconstructDisplayMessages(agent.messages)` − queued keys + 可选 resume notice，`transcriptEpoch++`；
10. 关闭 picker（`pickerMode=null`）；
11. **补（现状缺失）**：`settleAll("session-switch")`；顺带关 `statsPanel`；
12. 关联副作用（订阅联动）：goalStore `loadFrom`、`taskSnapshot` 重查、`pendingTaskCompletions` 放行、`contextUsage` 重算。

原子性：`state.ts` 上 `withTransaction(() => {...})` 包住 1-12，事务内改可变字段、不发通知，退出时 buildSnapshot + 单次 notify——满足 §8.4“无中间混合会话快照”。

## 5. 文件拆分与导入关系（`src/tui/controller/*`）

| 文件 | 职责 | 主要导入 |
|---|---|---|
| `controller.ts` | `BubbleTuiController` 实现：组装子模块，实现 `getSnapshot/subscribe/dispatch/shutdown`。 | 全部下述 + `../model/*` |
| `state.ts` | 全部状态的可变容器类 + 事务包装 + 单写者纪律。 | `../model/*` 类型 |
| `snapshot.ts` | `BubbleTuiSnapshot` 类型与 `buildSnapshot(state)` 不可变投影。 | `state.ts`、`../model/*` |
| `intents.ts` | `BubbleTuiIntent` 判别联合与 `ShutdownReason`。 | `../model/*` |
| `effects.ts` | `ControllerEffect` 判别联合与 `applyEffects` 执行器。 | `state.ts`、`ports.ts` |
| `ports.ts` | 环境端口：`FlushScheduler`、`clock`、`isMultiplexed()`、`SessionHostPort`、`gitBranchProbe`、进程退出回调——唯一定义副作用边界的地方。 | 仅类型 |
| `agent-event-reducer.ts` | 纯 reducer：`AgentEvent×RunState→{RunState, effects}`，含 Grok 白名单守卫与 `reduceRunFinish`。 | `../model/display-history`、`../../agent/input-controller`、`effects.ts` |
| `session-transition.ts` | 两阶段切换事务与清理清单、原子 commit。 | `ports.ts`、`state.ts`、`overlay-controller` |
| `overlay-controller.ts` | 阻塞请求生命周期：有主请求、幂等 settle、teardown 终局、picker/stats 状态。 | `../../question`、`state.ts` |
| `task-runtime-controller.ts` | processManager 订阅、wake 合流与门控、`/loop` 定时器 defer-not-stack、goal 续跑、孤儿任务探测。 | `../../tasks/*`、`../../goal/*`、`../../loop/engine`、`ports.ts` |
| `src/tui/testing/fake-agent.ts` | 脚本化回放 `AgentEvent[]`（含 abort/grok 流）的假 Agent。 | `../../agent` 类型 |
| `src/tui/testing/spy-host.ts` | headless spy host：假定时器/假时钟/记录式 sessionHost，记录效果序列与快照版本流。 | `controller/*` |

导入纪律：`controller/**` 与 `testing/**` 禁止 import `ink`/`react`/`pi-tui`/`tui-ink/**`。方向：`controller → model → (agent/session/tasks/goal/loop)`。

## 6. 迁移策略（分提交，旧 Ink TUI 全程可编译可测试）

原则：**不 retrofit** —— app.tsx 不接控制器；抽取以“机械搬运 + spy host 验证”推进；窗口期内任何行为修复同 commit 镜像到 reducer 并先写 reducer 测试。

| # | 提交 | 内容 | 验证 |
|---|---|---|---|
| 1 | `refactor(tui): add controller contracts` | intents/snapshot/ports/effects 纯类型 + state 骨架。 | tsc + 全量 vitest。 |
| 2 | `refactor(tui): move display model under src/tui/model` | display-history 迁移 + tui-ink re-export。 | 存量测试原样绿。 |
| 3 | `refactor(tui): extract agent event reducer` | 1657-1854 逐 case 等价搬运 + FlushScheduler。 | reducer 单测：流式合并、tool 生命周期、willContinue、重试去重、取消、Grok 白名单、40ms 假时钟。 |
| 4 | `refactor(tui): extract input queue state machine` | steer/queue 状态机 + drain 门控。 | 全路径单测。 |
| 5 | `refactor(tui): extract overlay request lifecycle` | OverlayRequestController + settleAll。 | teardown 终局测试。 |
| 6 | `refactor(tui): extract session transition` | 事务 + 清理清单 + 原子 commit。 | 事务测试：失败保留旧会话零 notify；成功十二项断言。 |
| 7 | `refactor(tui): extract task/goal/loop runtime` | wake/loop/goal/孤儿探测。 | 假时钟调度测试。 |
| 8 | `feat(tui): add BubbleTuiController` | 组装 + fake-agent + spy-host。 | headless 集成：完整会话断言快照序列、效果恰好一次、shutdown 无泄漏。 |

每步出口条件：`npx tsc --noEmit` 干净、全量 `vitest run` 绿、app.tsx 不动。`run.tsx`/`main.ts` 在 Phase 3 不动。

## 7. 风险与未决项

1. **双份 switch 的镜像成本**（提交 3 起）：任何触及 app.tsx:1657-1854 的修复须镜像进 reducer；
2. **`settleAll` 是行为增量**：需确认 agent 侧 abort 善后不与新 settle 双重 resolve（幂等已防）；
3. **`DisplayMessage` 双版本**：提交 2 采用“tui-ink 版本升级为规范版并加 re-export”路径，保 desktop 消费者不破；
4. **`nowTick`/elapsed 显示**：快照只带 `startedAt`/`endedAt` 数据，动画时钟归渲染器。
