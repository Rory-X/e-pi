# Pi 1.1.0 的官方能力与 E-Pi 补丁对照

核对日期：2026-10-08。目标是截图中可升级的正式版本 `1.1.0`，对照 E-Pi 当前内置的 `0.99.2`。

结论：**官方新版本确实改善了长会话内存、图像和选择体验，但没有完整替代现有 E-Pi 补丁的任何一项核心能力。** 虚拟 transcript、跨帧块缓存及失效、宽度变化时的块锚点、外部输入框布局、宿主精确滚动和导航协议仍需适配。官方新增的实现全部保留；不把“默认 fullscreen”或“内存约降至五分之一”当成已经实现可见区渲染。

## 依据与范围

核对两个官方 npm 包的原始发布内容，而不是 E-Pi 的已打补丁依赖：

- [pi-coding-agent@0.99.2][agent-old] 与 [pi-coding-agent@1.1.0][agent-new]。
- [pi-tui@0.99.2][tui-old] 与 [pi-tui@1.1.0][tui-new]。
- 官方 `v1.1.0` tag 指向提交 [abe508e1b89912adde45528136c3221eb69acdd7][release]；下文源码引用固定到这个提交。
- E-Pi 的两份 `0.99.2` 补丁与 `resources/e-pi-tui-hooks.mjs`，逐项核对其实际作用。

两版本下列正式发布文件逐字相同：`pi-tui/dist/components/scroll-view.js`、`pi-tui/dist/layout.js`、`pi-tui/dist/tui.js`、`pi-tui/dist/wheel-scroll.js` 和 `pi-coding-agent/dist/modes/interactive/chat-viewport.js`。这些是虚拟布局、Container 失效、滚动和外部输入框补丁的主要依赖，说明版本号跨入 1.x 本身并没有带来相应替代实现。[agent-old]、[agent-new]、[tui-old]、[tui-new]

## 逐项决定

| E-Pi 能力                              | 官方 1.1.0 的实际实现                                                                                                                                                     | 决定                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 长 transcript 只渲染可见块与 overscan  | `ScrollView.render()` 仍调用整个 child 的 `render()`；scroll 布局先计算整个 child 的高度，再裁剪输出。两处与 0.99.2 相同。[scroll]、[layout]                              | 保留虚拟布局。官方裁剪最终屏幕并不免除全部 transcript 的渲染和测量。                         |
| 按块、按宽度的跨帧缓存                 | 官方 `renderLayoutFrame()` 每帧创建一个新的 `renderCache`；它避免同一帧重复渲染，组件自身另有最近一次宽度缓存。[layout]、[frame-cache]、[markdown]、[text]                | 保留 E-Pi 多宽度块缓存。官方的解析 token 缓存和行缓存照常使用。                              |
| 文本、Container、动态 widget 失效      | 官方 `invalidate()` 清理本组件缓存并向子节点传播；没有 E-Pi 跨帧缓存所需的 revision。widget 工厂仅创建组件并请求渲染。[container]、[markdown]、[text]、[widgets]          | 保留 revision 与动态 widget 的 volatile 标记；新 `Text.setPaddingX()` 也必须使外层缓存失效。 |
| 空闲时补全屏幕外块的精确高度           | 官方 ScrollView 的 timer 仅负责隐藏 scrollbar；布局直接计算全文高度，没有延后补全或取消过期补全的路径。[scroll]、[layout]                                                 | 保留 idle hydration。                                                                        |
| 自动跟随尾部与 resize 时稳定阅读位置   | 官方已有 follow-end，非跟随状态按旧数值 `scrollTop` 截断到合法范围；没有“组件 + 块内行”的锚点恢复。[scroll]                                                               | 继续使用官方 follow-end 规则，保留 E-Pi 为估算高度、补全和重新换行增加的块锚点。             |
| 原生滚轮加速和 Alt 倍率                | 官方 0.99 已有 `WheelScrollAccelerator`，1.1 保留 `routeWheel(event, delta)` 和 Alt 五倍滚动。[wheel]、[native-wheel]                                                     | 保留官方手势计算，E-Pi 只适配宿主传入的精确行数。现有补丁没有自行替代加速算法。              |
| 宿主精确滚轮、跳到消息、回到底部       | 官方输入识别 SGR/X10 滚轮和键盘；没有 `e-pi:viewport:*` 私有输入协议。[native-wheel]                                                                                      | 保留宿主桥接。精确行数直接交给官方路由，不改变原生手势状态。                                 |
| 外部 composer 的 dock 与 widget 布局   | 官方 `createChatViewport()` 仍把 pending、status、widget、editor、footer 全部放在固定 dock，editor 最小高度为 3。[dock]                                                   | 保留 E-Pi 外部输入框布局；关闭优化时使用完整官方 dock。                                      |
| 宿主视口 OSC 6973                      | 新 OSC 7501 报告运行状态，只有 working、blocked、done、error、idle，既无 scrollTop/maxScrollTop，也无 follow-end 数据。[program-status]、[terminal-doc]                   | 保留视口协议。OSC 7501 与它用途和数据不同。                                                  |
| 消息导航 OSC 6974 与侧栏标签、回复摘要 | 官方已有 terminal 内的 prompt 跳转，但未提供给宿主的消息块索引、标签、摘要或偏移表；OSC 7501 明确不报告 prompt 和模型输出。[prompt-nav]、[program-status]、[terminal-doc] | 保留导航块注册、索引及 OSC。                                                                 |

## 官方改善直接采用

1. **内存优化**：Markdown 的解析 token 树改为 `WeakRef`；Markdown、Text、Box 对缓存行执行 `flattenLines()`，避免字符串保留大块父字符串；user-message 不再保留两份全宽渲染行。官方 TUI changelog 将长 assistant message 的堆保留描述为此前约五分之一。这改善的是每个已渲染消息的内存，不改变全文测量和渲染路径。[tui-changelog]、[markdown]、[text]、[user-message]
2. **选择与截图接口**：`TuiAltScreen.getScreenLines()` 返回上一帧屏幕行；`resetTextSelection()` 清除选区和连续点击状态，interactive mode 在 transcript 重建时调用它。[screen-api]、[rebuild]
3. **图像绘制修复**：WezTerm 的 Kitty 图像覆盖行变化也触发重绘，清屏和文本写入后再绘制图像，避免滚动后图像变成单行。[image-render]、[tui-changelog]
4. **状态与输出布局**：保留 OSC 7501 的支持检测和报告，`Text.setPaddingX()`、`Box.setPaddingX()` 以及新的 outputPad 行为。[tui-changelog]、[text]、[agent-changelog]
5. **原生滚动与键盘行为**：保留官方滚轮加速、Alt 倍率及 `Ctrl+Home`/`Ctrl+End` 的 transcript 跳转，`Home`/`End` 继续移动编辑器光标。[native-wheel]、[tui-changelog]

现有 E-Pi `0.99.2` 的 Markdown 补丁仅加入失效 revision，已经保留官方 token 解析缓存；没有另一套解析缓存需要因 `WeakRef` 上线而撤掉。老版本兼容文件不应套在 1.1.0 上。

## 适配边界

`Markdown` 和 `Text` 的正式源码已经变化，旧 diff 在相应上下文不能精确应用。1.1.0 使用以原始发布包重新生成的专用补丁，保留新 `WeakRef`、`flattenLines()`、padding setter、选择重置、图像渲染和状态报告。不能只放宽兼容性版本检查，或为套用旧补丁还原官方文件。

Pi agent 与 TUI 的 1.1.0 发布包均声明 Node `>=22.19.0`，E-Pi 的 bundled Node 需要继续满足该要求。[agent-new]、[tui-new] 此外，官方 TUI 1.1.0 要求自定义 `Terminal` 实现提供 `setProgramStatus(status)`；不支持 OSC 7501 的 terminal 可提供 no-op。真实运行使用官方 `ProcessTerminal`，测试替身也应满足新接口。[tui-changelog]

运行时 hook 与磁盘补丁中重复的 OSC/输入处理是 E-Pi 自己的维护面，不能视为被官方取代。若归并到单一入口，应保留缺失 preload 的失败检测以及“每帧只发一次”的行为检查。

## 验证范围

本报告的上游能力结论来自原始正式包的源码逐项对照和固定提交引用，并由正式包行为测试补充。仓库的 agent/TUI 依赖、pnpm 锁文件和安装时补丁均固定到 `1.1.0`，新增 `1.1` 兼容 profile；原有 0.84–0.99 的兼容文件继续用于旧安装，不会套到 1.1.0 上。

- 直接对照未打补丁与适配后的正式 1.1.0：1000 个历史消息块，12 行视口，宽度 48 → 96。官方每个宽度渲染 **1000 块**；E-Pi 分别渲染 **7 / 10 块**，可见内容逐行一致。这是渲染调用数比较，不代表耗时的同等倍数。
- 官方 dock 在关闭优化时保持一致；开启后 status/widget 随 transcript 滚动，交互 editor/footer 保持固定。
- 新 `Text.setPaddingX()` 会使虚拟块缓存正确失效；Markdown 使用官方 `WeakRef` token 缓存，主题失效后重新渲染且复用仍存活的解析结果。
- 完整 Vitest：**53 个文件，507 项通过**。包含真实发布包、原生滚轮/Alt 加速、宿主精确行数、每帧仅一次 OSC、导航跳转、虚拟布局失效/锚点/idle hydration，以及更新服务从 0.99.2 下载并安装 1.1.0，`fallbackToStock: false`。
- `pnpm typecheck`、生产构建通过；lint 无 error，只有仓库既有的 `no-await-in-loop` warning。
- 真实 PTY 启动官方 CLI 并加载 E-Pi bridge：开启/关闭优化均得到 idle sidecar，没有 extension 加载错误；开启时滚动/消息跳转/96×24 resize 标签正常，关闭时不发 E-Pi OSC。两种模式均保留官方 OSC 7501。测试使用隔离的临时配置和预制会话，没有提交模型请求。

## 安装包核验

已生成 Apple Silicon 安装包 `dist/pi-1.1.0-20261008/E-Pi-0.1.0-pi-1.1.0-arm64.dmg`（约 195 MiB）。只读挂载 DMG 后确认：

- Pi CLI 和 agent、TUI、agent-core、AI、MCP、codemode、chord、telemetry 均为 `1.1.0`；使用内置 Node `22.23.2`。
- `app.asar` 含 `1.1` 兼容 profile 与自动化 IPC/executor；两份 1.1.0 补丁与仓库内容逐字一致。
- 直接从 DMG 启动 bundled Node、CLI 和 bridge，两种优化模式的 PTY 检查均通过；官方 OSC 7501 与 E-Pi 的专有协议并存。
- DMG checksum 与 ad-hoc 签名通过；完整记录见同目录 `verification.json` 和 `.dmg.sha256`。

[release]: https://github.com/earendil-works/pi/tree/abe508e1b89912adde45528136c3221eb69acdd7
[agent-old]: https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.2.tgz
[agent-new]: https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.1.0.tgz
[tui-old]: https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.99.2.tgz
[tui-new]: https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-1.1.0.tgz
[scroll]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/components/scroll-view.ts#L129-L220
[layout]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/layout.ts#L68-L177
[frame-cache]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/layout.ts#L379-L392
[container]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui.ts#L347-L402
[markdown]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/components/markdown.ts#L236-L375
[text]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/components/text.ts#L7-L109
[widgets]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2398-L2437
[wheel]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/wheel-scroll.ts
[native-wheel]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L678-L720
[prompt-nav]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L504-L519
[dock]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/chat-viewport.ts#L22-L49
[program-status]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/program-status-reporter.ts
[terminal-doc]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/terminal-setup.md#program-status
[user-message]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/components/user-message.ts#L61-L66
[screen-api]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L316-L325
[rebuild]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4093-L4098
[image-render]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L1703-L1785
[tui-changelog]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/CHANGELOG.md
[agent-changelog]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/CHANGELOG.md
