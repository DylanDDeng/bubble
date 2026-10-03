# Figma 桌面画布解包与 Bubble 编辑交互差距

检查日期：2026-10-01。任务是只读调查本机 Figma 安装包与编辑器静态缓存，定位 Bubble 无法直接编辑元素的原因。未修改 Figma 安装、登录状态或设计文件；本轮未修改 Bubble 产品源码。

## 结论

Figma 的直接编辑能力来自独立的场景图、交互行为、文字编辑与撤销系统。图层列表只是这套模型的一个视图。Bubble 当前拥有 HTML 层级树和属性写回，但尚未实现元素的拖拽/缩放行为及画布内文字编辑，因此仍然不能提供相同的直接操作体验。

不必为了接近这种体验先改用 C++ 或 WebAssembly；需要先补齐编辑器的行为与操作模型。渲染技术和直接编辑能力是不同层次的问题。

## 本机证据和来源

- 安装：`/Applications/Figma.app`，版本 **126.8.18**，bundle `com.figma.Desktop`。进程路径也指向该安装。
- `app.asar` 为 9,875,304 bytes，SHA-256 `f7340fe90393f9a904ef41c659c06493531b2bc016f0295c3e2a48361a5a5162`。
- 解包目录：`desktop/artifacts/figma-investigation/app/`。103 个文件通过 ASAR 内置完整性哈希验证；3 个 unpacked 原生文件与安装目录逐字节哈希一致。标准提取器对 `.codesign` 的 size=-1000 元数据项报错，其余文件已提取并验证，未尝试恢复这项签名元数据。
- 缓存来源：`~/Library/Application Support/Figma/DesktopProfile/v42/Cache/Cache_Data`。只解码匹配静态 JS/WASM URL 的缓存响应，不读取 Cookies、账号存储或设计文档数据库。
- 编辑器 JS：`figma_app-cd321eccffa2635a.min.js`，解压后 8,045,991 bytes。
- Fullscreen WASM：构建路径 `e5d7b9241f02ecbdf0527917a3452eafb2b97206/fullscreen-wasm`，解压后 **51,281,767 bytes**；同构建 JS 绑定层为 2,319,734 bytes。
- 缓存可能包含多个版本。上述资源存在于本机缓存，不等于已通过当前页面网络记录证明它们全部正在执行。文件 URL、缓存来源、解压结果与 SHA-256 位于 `desktop/artifacts/figma-investigation/editor/manifest.json`。

可阅读的代码摘录与 WASM 字符串偏移：`desktop/artifacts/figma-investigation/evidence.md`。保留的 `.cpp/.h` 路径是编译产物里的诊断字符串，不是完整恢复的 C++ 源码。

## 实现线索

| 能力 | 找到的证据 | 可以确认的结论 |
| --- | --- | --- |
| 桌面宿主 | `createAndLoadWebContentsView`，`web_app_binding_renderer.js`，sandbox/contextIsolation | 桌面壳与编辑网页分层；ASAR 不是全部编辑引擎 |
| 加载编辑内核 | `WebAssembly.instantiateStreaming`、`instantiate`；对应 WASM 文件 | 网页确实有独立的 WASM 模块与加载流程 |
| 场景图和选择 | `getActiveTSSceneGraph()`、`getDirectlySelectedNodes()`、`guid`；`FGSceneGraph.cpp` | 选择指向场景节点，图层并非仅从可见 HTML 列表推导 |
| 指针输入 | pointermove/up 监听 → `this.mouseEvent`；`this.cppAPI.mouseEvent` 携带坐标、按钮、修饰键和设备类型 | JS 将标准化输入交给编辑内核；不是每个图形各自处理原生 DOM 拖动 |
| 命中与手柄 | `HitTestBindings.eventHitTestCornerOrEdgeBounds`、`FGHitTest.cpp` | 有专用的节点/边角命中机制 |
| 移动/缩放 | `FGMoveSelectionBehavior.cpp`、`FGResizeSelectionBehavior.cpp`、`FGMoveTransformer.cpp`、`FGScaleTransformer.cpp`、`FGNodeTransform.cpp` | 编译模块包含独立的移动/缩放行为与变换模块；具体算法未恢复 |
| 文字输入 | compositionstart/update/end；`this.cppAPI.textEvent`；`FGTextEditor.cpp`、`FGTextEditModeUi.cpp` | 有输入法合成处理及独立的文字编辑模式，不能用属性面板文字框等价替代 |
| 撤销 | `UndoBufferBindings.undo`、`nextUndoBatchPageIds`、`topUndoBatchTimestamp`、`FGUndoRedo.cpp` | 有操作批次式撤销机制；不能直接推出其所有协作合并细节 |
| 渲染 | `getContext("webgl2")`、`getContext("webgl")`、`getContext("webgpu")`、`FGSceneGraphRenderTree.cpp` | 存在 GPU 渲染路径；未验证当前机器实际使用哪个后端 |

从这些模块和调用可归纳出：输入归一化 → 命中/选择 → 编辑行为 → 场景节点变换/文本变化 → 重绘及操作历史。它是有代码证据支持的架构归纳，不是完整函数级调用栈或性能结论。

## Bubble 的具体缺口

1. `desktop/src/ui/components/design/DesignCanvas.tsx` 的 Gesture 只有 pan、move、marquee、resize，移动/缩放针对 `DesignBoard`。选中内部元素后，pointerdown 走 `inspect(board, point)` 后直接返回，没有启动元素编辑手势。
2. `DesignPanel.tsx` 的 `onElementCommand` 仅处理 remove、duplicate、nudge。方向键通过修改元素的 CSS left/top 实现，没有拖动预览、边角尺寸手柄、旋转或父节点变换处理。
3. `DesignLayers.tsx` 的文字、CSS 修改在输入框失焦时保存。画布上的双击仍然只选中元素，不能直接放置文字光标、选择文字或处理 IME。
4. 内容写回是整张画板 HTML + expectedRevision。历史恢复保证文档版本，但还没有用户手势粒度的 Cmd/Ctrl+Z 撤销/重做栈。

因此，前一轮实现的准确状态是“HTML 图层树和属性编辑器”，不能称为 Figma 式直接编辑完成。

## 建议的下一步实现边界

先补 HTML 元素的直接操作，保留现有文档、Agent 工具、会话和导出管线。暂不启动完整 Figma 矢量引擎重写。

- **统一节点操作**：建立 text/style/transform/reorder/reparent 的命令与事务边界；画布、属性面板和 Agent 复用同一写入路径和 revision 检查。持续保留稳定节点 ID。
- **元素手势状态**：增加 element-move、element-resize、text-edit。pointerdown 保存起始节点和布局；pointermove 只做本地预览；pointerup 提交一次；Escape 回滚。选择边框提供八个真实命中手柄。
- **布局语义**：绝对定位元素可以直接位移；Flex/Grid 子元素默认排序或调整布局属性。显式切换到自由定位时再转换到父坐标空间，避免默认破坏响应式排版。
- **原位文字编辑**：双击进入文字编辑覆盖层，接管光标、选区和 IME；编辑文本片段而非替换整个富文本父节点；提交后保留字体和布局。Esc 与撤销有明确边界。
- **操作历史**：一次拖动或一段文字编辑形成一个 undo transaction，而非每个 pointermove 写一个版本。Agent 在编辑期间修改相同内容时，结束手势前检查版本并解决冲突，不能覆盖新内容。

第一批验收应是：拖正文中的按钮只移动按钮；缩放手柄只改选中元素；双击标题直接出现文字光标且中文输入不重复；Esc 取消、Cmd/Ctrl+Z 撤销一次完整操作；切换聊天后恢复已提交结果；只读/锁定、父容器布局和 Agent 并发写入不被破坏。
