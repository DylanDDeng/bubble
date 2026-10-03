# Skill 目录常驻方案（草案，待确认）

日期：2026-10-03
状态：已实现（2026-10-03），评估待跑

## 1. 背景与问题

**现状。** `51f6359 feat(skills): add on-demand skill search`（2026-05-25）把系统提示里的 "Available skills:" 列表删掉了，改成"先搜后加载"。现在模型每轮能看到的只有三样：

- 系统提示里一句通用指引（`src/prompt/compose.ts:118`）："任务像专门流程时，先 `skill_search` 再 `skill`"。
- `skill_search` 工具。
- `skill` 工具，说明是"当任务明确匹配可用 Skill 时使用"，但模型并不知道有哪些可用 Skill。

**后果。** 模型看不到任何 Skill 的名字和简介。要用上一个 Skill，它得先凭空怀疑"可能有相关 Skill"，再猜中搜索词，最后才去加载。第一步完全没有依据，所以触发率低是结构性问题，和具体模型关系不大。

**实测。** 2026-10-03，用 kimi-for-coding k3 在桌面端让 Bubble"再设计一个 PC 端详情页"。工具说明里写了"先加载 bubble-design"，它整个会话一次也没调用 `skill`。

**一般做法。** Agent Skills 规范、Claude Code、Codex 都是三级加载：

1. 名字 + 一行简介常驻上下文；
2. 判断匹配后再读正文；
3. 用到时再读附带资源。

Bubble 少了第 1 级。

**次生问题。**

- 子 Agent 有 `skill` 工具，但既没有目录也没有 `skill_search`（只读预设里没有它），等于有工具也用不上。
- 上下文用量统计里的 "Skills" 一栏永远是 0，因为它按原先的目录格式去系统提示里找文本。
- 同名 Skill 的优先级是：用户目录在前，项目 `.bubble/skills` 在后。所以项目自己的同名 Skill 会被用户全局的覆盖，和"项目优先"的直觉相反。

## 2. 本机实测数据

根目录：`~/.agents/skills` 87 个，`~/.claude/skills` 104 个，另加桌面自带的 1 个（bubble-design）。

| 项目 | 数值 |
|---|---|
| 去重 + 去掉禁用后可见的 Skill | 108 个（user 107，configured 1） |
| 简介长度 中位数 / P90 / 最大 | 162 / 398 / 943 字符 |
| 旧格式（简介截到 200 字，总预算 6000 字符） | 只能列出 42 个 |
| 全部列出，简介截到 80 字 | 8.7k 字符，约 2.5k token |
| 全部列出，简介截到 120 字 | 11.4k 字符，约 3.3k token |
| 全部列出，简介截到 160 字 | 13.9k 字符，约 4.0k token |

## 3. 目标与非目标

**目标**

- 恢复三级加载：模型每轮都能看到"有哪些 Skill、各自什么时候用"。
- 目录有预算上限，超出部分交给 `skill_search`。
- 对提示缓存友好：Skill 不增删，系统提示就逐字节不变。
- 所有宿主（TUI、SDK/桌面、飞书）和子 Agent 行为一致。

**非目标**

- 不做强制加载，也不做"没加载就拒绝写入"之类的硬拦截。
- 不按"最近使用"排序，避免目录频繁变化、打掉缓存。
- 本次不改同名 Skill 的优先级，见 §6。

## 4. 方案

### 4.1 目录放在哪：系统提示末尾

在 `composeSystemPrompt` 的最后一节（memoryPrompt 之后）追加 `## Skills`。

理由：

- **缓存**：目录放在最后，前面各节逐字节不变；只有 Skill 增删或启用状态切换时才变化。
- **一致性**：SDK 每轮、飞书每次运行都会重建系统提示，TUI 在切换模型时也会重建。放进系统提示，各宿主天然一致，子 Agent 也能复用同一个格式化函数。

备选方案是模仿 deferred tools，以一次性 `<system-reminder>` 注入。好处是系统提示块不变；缺点是每个会重设 `agent.messages` 的宿主都得记得重新注入（目前 TUI 和飞书各有一处），漏一处就丢，所以不选。

### 4.2 格式

```
## Skills
Skills are task-specific instructions you load on demand. When a task matches a skill below, call `skill` with its exact name before starting, then follow it. Load only what clearly applies.
- bubble-design: How to design good webpage and app mockups on Bubble's Design canvas — …
- repo-review: …
- … and 23 more skills not listed here; use skill_search to find them.
```

规则：

- **每行**：`- 名字: 简介`。简介截到 **120 字符**，加 "…"。tags 不再输出，它对判断帮助不大，还占预算。
- **预算**：默认 **12,000 字符**（约 3.4k token）。在本机数据下，108 个 Skill 能全部列出。可通过 config `skills.catalogChars` 调整，0 表示关闭目录、退回纯搜索。
- **排序**：先按来源，project > configured（包括桌面自带的 `skillPaths`）> user，同来源内按名字。排序完全确定，不受使用记录影响。
- **超出预算**：按上面的顺序截断，末行写"还有 N 个未列出，用 `skill_search` 查找"。只有发生截断时，指引里才提 `skill_search`。
- **不列出的 Skill**：已禁用的、`disable-model-invocation` 的 Skill 不列（沿用 `promptVisible()`）。

### 4.3 指引与工具文案

- **`compose.ts` 的通用指引**：有目录时，由目录自身的说明行告诉模型怎么加载，不再另给指引；只有没有目录时（宿主没传、预算为 0），才保留"先 `skill_search` 再 `skill`"那句。`skill_search` 的提示放在目录被截断时的末行。
- **`skill` 工具说明**：改成 "Load a skill listed in the Skills section of the system prompt"。
- **加载出错**：名字不存在时，报错里列出最接近的 3 个名字，替代现在的"去搜一下"。
- **`skill_search` 工具保留**：没有截断时它几乎用不上，但留着，长尾 Skill 和不确定时还能用。

### 4.4 何时重建

| 宿主 | 现状 | 改动 |
|---|---|---|
| SDK / 桌面 | 每轮重建，注册表每轮新建 | 传入 summaries 即可 |
| 飞书 | 每次运行重建 | 同上 |
| TUI | 启动时构建；切换模型时 `syncSystemPrompt` 会重建 | `/skills` 面板切换启用或 reload 后调用 `syncSystemPrompt`。现在只调 `setSkillSummaries`，系统提示不会更新 |
| 子 Agent | 不带目录 | 子 Agent 只要有 `skill` 工具，就带同一份目录（恢复 51f6359 之前的行为） |

### 4.5 上下文用量

继续用 `formatSkillsPrompt` 生成目录，`usage.ts` 的 Skills 一栏按原逻辑就能统计出来；只需改成匹配新的标题和格式。桌面端的上下文指示器目前不显示 Skills 一栏，可以顺手加上（可选）。

### 4.6 用户侧治理

上下文太多时，正确做法是删掉或禁用不用的 Skill，而不是把目录藏起来。为此提供可见性：

- `/skills` 面板顶部显示："目录占用 9,820 / 12,000 字符 · 108 个已列出"；有截断时显示"N 个未列出"。
- 有重复安装时，同时显示"N 个同名 Skill 被忽略"（数据来自现有的 duplicate 诊断）。
- 桌面 Skill Library 同步显示同样的统计（可选）。

## 5. 改动清单

- `src/skills/format.ts`：新的标题和格式、120 字符截断、预算参数、来源排序、超额行。
- `src/prompt/compose.ts`、`src/system-prompt.ts`：恢复 `skills` 入参，追加目录节，调整指引。
- `src/agent.ts`：`getSystemPromptToolOptions()` 带上 skills；新增 `setSkillSummaries` 后重建系统提示的钩子。
- `src/agent/subagent/runtime.ts`：子 Agent 有 `skill` 时带上目录。
- 宿主接线：
  - `src/main.ts`、`src/feishu/agent-host/run-driver.ts`、`src/sdk/index.ts`：构建系统提示时传入 summaries。
  - `src/slash-commands/commands.ts`：`syncSystemPrompt` 带上 summaries。
  - `src/tui/app.ts`：`/skills` 面板改动后同步系统提示。
- `src/tools/skill.ts`：工具说明；名字不存在时报错列出相近名字。
- `src/config.ts`：新增 `skills.catalogChars`。
- `src/context/usage.ts`：匹配新格式。
- 桌面：无需改动。`skillPaths` 已经接好，bubble-design 会以 configured 来源出现在目录里。

## 6. 本次不做，单独跟进

- **同名优先级**：项目 `.bubble/skills` 应该覆盖用户全局的同名 Skill，现在是反过来的。改它会影响已有用户，单独讨论。
- **按使用频率排序、固定某些 Skill 常驻**：等有了预算压力的真实反馈再做。
- **简介质量提示**：在 `/skills` 里提示简介超过 120 字被截断的 Skill。可以以后做。

## 7. 测试与评估

- **单测**：
  - 格式与预算：截断、排序、超额行、禁用项不出现。
  - 系统提示：确实包含目录，Skill 不变时逐字节相同。
  - 子 Agent：有 `skill` 时带目录。
  - 用量统计：Skills 一栏不再是 0。
- **需要更新的现有测试**：
  - `src/__tests__/skills-prompt.test.ts`，现在断言系统提示里没有目录。
  - `src/__tests__/agent.test.ts:1340`，子 Agent 不应出现 Skill 名。
  - `src/__tests__/context-budget.test.ts`，依赖旧格式。
  - `slash-commands` 和 `tui-context-info` 的相关 fixture。
  - `tools/__tests__/skill.test.ts`，未知 Skill 的报错文案。
- **评估**：用 `evals/` 的对比评测，固定 model 和 thinkingLevel，加几道"应当触发某 Skill"的任务。其中包括这次的"在已有设计稿里加一个 PC 详情页 → 应加载 bubble-design"。对比改动前后的触发率，同时统计误触发：不该加载却加载的次数。

## 8. 风险

- **token 成本**：按本机数据，每轮多约 3.4k token。系统提示前缀可缓存，实际增量主要发生在首轮或缓存失效时。
- **缓存失效**：切换 Skill 的启用状态会让系统提示变化，Anthropic 的 messages 缓存随之失效一次。tools 的缓存不受影响。
- **误触发**：目录可见后，模型可能过度加载。指引里写明 "Load only what clearly applies"，评估时观察误触发率。

## 9. 待确认

1. 预算默认 12,000 字符、简介截到 120 字，这两个数值是否合适？
2. 子 Agent 是否也带目录？建议带。
3. `skill_search` 是否保留？建议保留，用于截断时兜底。

## 10. 实现记录（2026-10-03）

按 §4 实现，三个待确认项都按建议定：预算 12,000 字符、简介截到 120 字；子 Agent 也带目录；保留 `skill_search`。

- **核心实现**：
  - `buildSkillCatalog` / `formatSkillsPrompt` 在 `src/skills/format.ts`。
  - `compose.ts` 把目录追加为系统提示的最后一节；有目录时不再给"先搜后加载"的指引。
  - 配置 `skills.catalogChars`。
  - `Agent.getSystemPromptToolOptions()` 返回 skills 和预算，所以切换模型、`/skills` 改动（TUI 改动后调用 `syncSystemPrompt`）重建提示时目录都还在。
  - 子 Agent 有 `skill` 工具时带上同一份目录；子 Agent 没有 `skill_search`，所以目录不提它。
- **`skill` 工具**：说明指向 Skills 目录；名字写错时给出最接近的 3 个候选。
- **上下文统计**：从系统提示里实际存在的 `## Skills` 一节统计，不受预算配置影响。
- **`/skills` 面板**：顶部显示"catalog X/12,000 chars · N listed · N not listed · N duplicates ignored"。
- **本机实测**：108 个 Skill 全部列出，目录约 11.6k 字符，其中中文 2,327 字。按 Bubble 自带的 token 估算器：OpenAI 约 4.1k token，Anthropic、Kimi、DeepSeek 约 4.8k token。中文简介会让 token 数明显高于"字符数 ÷ 3.5"的粗算。
- **简介要把触发条件写在前 120 字**：bubble-design 的简介原来恰好在"什么时候加载"之前被截断，已改成触发条件写在最前面。
- **测试**：
  - `skills-prompt.test.ts` 重写：位置、确定性、截断与超额行、关闭目录时回退、没有 `skill` 工具时不出现、用量统计、重建。
  - 另外更新了 `agent.test.ts`（子 Agent）、`skill.test.ts`（相近名字），`tui-skills-panel.test.ts` 新增统计行。
  - 核心 `src` 全量 4610 个测试通过。
- **待办**：用 `evals/` 做改动前后的触发率对比，需要真实模型调用，尚未运行。

## 11. Review 后的修复（2026-10-03）

- **用量统计**：用"标题 + 固定说明行"作为标记，并取最后一次出现的位置来识别目录。AGENTS.md 或记忆里的 `## Skills` 不会再被误认成目录。
- **截断**：按码点截断，emoji 不会被切成残缺字符（有的 API 会因此直接返回 400）。
- **排序**：按字符码排序，不再用 `localeCompare`，保证跨运行时逐字节一致。
- **飞书**：子 Agent 也使用配置的预算。
- **TUI 重建提示**（`/skills` 改动、`/model`）：没有模型时也会重建，占位值和启动时一致。
- **`--cwd`**（既有问题，一并修复）：原来 `--cwd` 只记在参数里，TUI 的每轮 cwd、会话列表、状态栏、斜杠命令仍用启动目录。现在 CLI 入口处把它解析为绝对路径并 `process.chdir` 过去（`enterWorkingDirectory`），语义同 `git -C`；目录不存在或不是目录时报错退出。
- **`skill` 工具**：说明和报错不再提 `skill_search`，因为子 Agent 没有这个工具。相近名字要求片段至少 3 个字符。
- **清理**：删除了没有调用方的 `src/prompt/skills.ts`。
- **测试**：新增 4 个用例：AGENTS.md 撞标题、emoji 截断、截断后的计数、启动与重建提示逐字节相同。
