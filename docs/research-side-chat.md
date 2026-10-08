# E-Pi 侧边临时聊天（Side Chat）实现调研

Date: 2026-09-11
Scope: 在主对话之外提供一个「侧边临时聊天」面板，用于临时提问/试验，不污染会话列表。
Status: 调研（不含代码改动）。结论基于对 e-pi 源码、`@earendil-works/pi-coding-agent@0.84.2` 源码与本机实测。

---

## 0. 结论（TL;DR）

**推荐方案 A：把「临时聊天」实现成第三种会话——草稿会话（draft session），仍然让 pi 以 fullscreen TUI 渲染，复用现有 xterm 管线。**

一句话机制：

> 用一个**不存在于磁盘的 session 文件路径** + **隔离的 `--session-dir`** 启动第二个 pi 进程；e-pi 现有的 `PiRuntime` / `TerminalPanel` / 活动侧车（`.e-pi-activity.json`）机制原样可用，而 `SessionManager.listAll()` 永远看不到这个会话，草稿文件也一个字节都不会落盘。

这意味着：**不需要新的渲染技术、不需要 RPC/SDK、不需要改 pi**，只需要给 `PiRuntime` 加一条「辅助会话（auxiliary session）」通道，并在右侧工具面板加一个 Chat 标签页。

关键实证（本机实测，非推断）：

```
$ pi --session /tmp/xxx/draft.jsonl --session-dir /tmp/xxx \
      --extension resources/e-pi-bridge.ts --mode rpc --offline --no-context-files
启动后 /tmp/xxx 内容：  ['draft.jsonl.e-pi-activity.json']
draft.jsonl 是否存在：  false
```

- ✅ 桥接侧车正常产出（说明 `ctx.sessionManager.getSessionFile()` 返回了该路径，`PiRuntime.#waitUntilReady` 的就绪探测能通过）
- ✅ `draft.jsonl` **从未创建**（`SessionManager.open()` 打开不存在的文件时保留显式路径、`persist=false`，纯内存）
- ✅ `SessionManager.listAll()` 扫的是 `<agentDir>/sessions`，草稿在隔离目录里，**不会出现在侧栏**

---

## 1. 需求边界：先决定「临时」指什么

「侧边临时聊天」有 4 个正交维度，方案差异几乎全由第 1 条决定：

| 维度           | 选项                                                        | 影响                       |
| -------------- | ----------------------------------------------------------- | -------------------------- |
| **① 产物形态** | (a) 完全不落盘 · (b) 落盘但在隔离目录 · (c) 落盘且进侧栏    | 决定是否要新写一套 UI 渲染 |
| **② 上下文**   | (a) 空会话 · (b) 复制主会话历史（fork 语义） · (c) 只带摘要 | 决定草稿文件怎么产生       |
| **③ 位置**     | 右侧工具面板新标签页 / 悬浮窗 / 第三栏                      | 决定布局改动量             |
| **④ 回灌**     | 手动复制 / 一键「发送到主会话」                             | 纯增量功能                 |

**建议的产品默认值**：①(a) 不落盘 + ②(b) 带主会话上下文 + ③右侧面板 Chat 标签页 + ④V2 再做一键回灌。

---

## 2. 架构现状（与本次相关的关键事实）

### 2.1 会话模型：一个 session 文件 = 一个 pi 进程

- `PiRuntime` 持有 `#instances: Map<sessionPath, Instance>`，一个 session 文件对应一个 pi 进程，惰性启动，互不干扰。
  `electron/main/services/pi-runtime.ts:148-166`、`~369-394`
- spawn 参数写死为：`pi --session <path> --extension <e-pi-bridge.ts> [--tui-mode fullscreen] [agent args]`
  `pi-runtime.ts:415-435`
- 进程「就绪」不是协议握手，而是**轮询桥接侧车** `<sessionFile>.e-pi-activity.json` 出现 `status: busy|idle`（30s 超时，收到输出会重置时限）
  `pi-runtime.ts:573-617`
- 侧车路径 = `dirname(sessionFile)/basename(sessionFile) + ".e-pi-activity.json"`
  `resources/e-pi-bridge.ts:410-413`

> **推论**：任何「第二个 pi 会话」只要有一个可写的 session 文件**路径**（文件本身不必存在），e-pi 全套机制就能原样复用。这是方案 A 的全部立足点。

### 2.2 渲染层：切会话 = 卸载终端组件 + 清 replay 缓冲

- `useSessionRuntime.activate()` 在会话 idle/exited/error 时 `clearTerminalBuffer(path)` 再 `runtime.start(path)`
  `src/hooks/useSessionRuntime.ts`（`activate`）
- `App.tsx` 以 `activePath` 为 key 挂载 `TerminalPanel`；切换会话时组件卸载/重挂载，靠 main 侧**重放缓冲** `terminalReplayStore`（LRU，`MAX_BUFFERED_SESSIONS = 6`）恢复画面
  `src/lib/terminalReplayStore.ts:19`
- `TerminalPanel` 通过 `runtime.onAnyData` / `runtime.onState` **按 sessionPath 过滤**，两个 xterm 实例各自消费自己的数据流
  `src/components/workspace/TerminalPanel.tsx:464,490`

### 2.3 布局：右侧已经是标签页容器，天然适合挂 Chat

- 右侧工具面板 `ToolPanel` 的 `PanelView` 目前是 `["review","files","terminal"]`，且**所有标签页保持挂载**（切标签不丢状态，终端 pty 亦如此）
  `src/components/workspace/ToolPanel.tsx`（`PANEL_VIEWS`、文件头注释）
- 侧边终端 `SideTerminalView` 的现成模式：组件挂载时 `sideTerminal.spawn(cwd)`，卸载时 `kill(id)` —— **pty 一关，历史就没了**。
  `src/components/workspace/SideTerminalView.tsx:567,577,679`

### 2.4 pi 侧可用的官方能力（0.84.2）

| 能力                              | 出处                                      | 说明                                                                          |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `--session <path>`                | `dist/cli/args.js:73`                     | 打开指定会话文件；**不存在则纯内存打开，不落盘**（实测）                      |
| `--session-dir <dir>`             | `dist/cli/args.js:73-74`                  | 会话存储/查找目录；`SessionManager.listAll()` 默认只扫 `<agentDir>/sessions`  |
| `--fork <path>`                   | `dist/main.js:286-299`                    | 从别的会话 fork 出新会话（新文件）                                            |
| `--no-session`                    | `dist/main.js:283-284`                    | 纯内存会话，`getSessionFile()` 返回 `undefined`                               |
| `--mode rpc`                      | `dist/modes/rpc/*`                        | 无头 JSON 协议（stdin/stdout），有 `RpcClient`、`RemoteSession`、`runRpcMode` |
| SDK                               | `dist/index.js` → `createAgentSession` 等 | 同进程内嵌 agent，可自定义 UI                                                 |
| `/new` `/resume` `/fork` `/clone` | `docs/sessions.md`                        | TUI 内的会话切换，fullscreen 下**无法被外部再切换**                           |

> **关于 `--no-session`（关键陷阱）**：它让 `getSessionFile()` 返回 `undefined` → 桥接的 `activityTarget()` 直接 `return undefined`（`e-pi-bridge.ts:410-413`）→ **不写侧车** → `#waitUntilReady` 永远等不到就绪 → 30s 后超时并 kill。**所以 e-pi 不能直接复用 `--no-session` 来做临时会话**，必须用「草稿路径 + 隔离目录」这一招。

---

## 3. 候选方案对比

|                    | **A. 草稿会话 + TUI（推荐）**                            | **B. RPC/SDK 无头 + 原生 UI**           | **C. 第二条 TUI 侧栏（拆第三个 pi 进程）** |
| ------------------ | -------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| pi 进程            | 第二个 fullscreen TUI                                    | `--mode rpc` / SDK 同进程               | 第二个 fullscreen TUI                      |
| 渲染               | 复用 `TerminalPanel`（xterm）                            | 需新建聊天 UI（markdown/工具调用/流式） | 复用 `TerminalPanel`                       |
| 落盘               | 不落盘（实测）                                           | 不落盘                                  | 不落盘                                     |
| 主对话上下文       | `cp` 主会话 jsonl 当种子即有                             | 需手工构造消息数组                      | 同 A                                       |
| 复用现有 e-pi 机制 | 侧车/就绪探测/replay/Composer 全复用                     | 全部新写                                | 全复用                                     |
| 新增代码量         | 小（~1 条 runtime 通道 + 1 个 PanelView + 1 个包装组件） | 大（一套聊天 UI + 事件转译）            | 中（布局大改 + 第三条栏）                  |
| 副作用面           | 需处理「主 TUI 被隐藏」的收尾                            | 无                                      | 需处理主 TUI 一直可见                      |
| 长期演进           | 可原地升级为 B                                           | 终态                                    | 不推荐                                     |

**否决项**：

- ❌ 用 `--no-session` 起临时会话 —— 侧车不产出，就绪探测必然超时（见 2.4 分析）。
- ❌ 复用「侧边终端 pty」承载对话 —— pty 关掉历史即失，且没有 pi 的会话语义。
- ❌ 在主 TUI 里开临时对话（靠 `/new` 或 `/resume`）—— fullscreen 会话切换后**无法从外部切回**，用户会失去主对话入口。
- ❌ TUI 内部 no-op 的临时对话框 —— 0.84.2 无此扩展点。

---

## 4. 推荐方案 A：详细设计

### 4.1 进程与文件

```
<userData>/side-chat/<draftId>/
├── draft.jsonl                  ← 草稿会话「路径」（可能永不落盘）
└── draft.jsonl.e-pi-activity.json   ← 桥接侧车（就绪探测 + 状态/用量）
```

- **启动前必须 `mkdir -p` 该目录**：桥接以 `writeFile(tmp) → rename` 写侧车，目录不存在会让 `writeFile` reject；而 `writeChain = writeChain.then(...)` 一旦被 reject 就**永久毒化**，后续状态全部丢失 → 面板永远起不来。
- 启动参数：`pi --session <dir>/draft.jsonl --session-dir <dir> --extension <bridge> --tui-mode fullscreen [agent args]`
  —— 两者都要带：`--session` 提供侧车锚点，`--session-dir` 保证会话（含用户 `/new`）产生的任何文件都落在隔离目录。
- 会话结束后 `rm -rf <dir>`；启动时参照 `cleanupStalePastedImages()`（`electron/main/index.ts:86+`）清一次残留。

### 4.2 上下文注入（是否带上主对话）

| 做法                                             | 效果                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| **默认：`copyFile(parent.jsonl → draft.jsonl)`** | 草稿会话以主对话全部历史开场（= `/clone` 语义），模型天然「知道」当前讨论 |
| 可选：不复制                                     | 空白临时聊天                                                              |

复制是零成本的（纯文件操作，`SessionManager.open()` 会正常加载），且因为 `draft.jsonl` 在隔离目录里，**不会出现在侧栏**。缺点：草稿上下文随主对话增长而变长（一次性快照，不跟随）。

### 4.3 主进程改动

| 位置                      | 改动                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-runtime.ts` `#launch` | `--session` 后面追加可选 `--session-dir`，并接受「额外参数/provider」注入                                                  |
| `PiRuntime`               | 新增 `startAuxiliary(key, { cwd, sessionDir, seedFrom? })`：spawn + 就绪探测 + 状态广播，**但绝不写 `#activeSessionPath`** |
| `index.ts`                | 新 IPC：`side-chat:open` / `close` / `submit` / `interrupt` / `resize` / `write` / `get-state`                             |

**⚠️ 必须绕开 `start()`**：`PiRuntime.start()` 第一行就是 `this.#activeSessionPath = sessionPath`（`pi-runtime.ts:150-153`）。若草稿走 `start()`：

- `activeCwd()` 会变成草稿的 cwd（影响 `git:*` / `fs:*` / `packages:*` 的兜底路径）；
- 主进程的 `notifications.observe(..., { activeSessionPath })` 会把**主对话**误判为「后台会话」，任务完成时弹通知。

### 4.4 渲染进程改动

1. `ToolPanel.tsx`：`PANEL_VIEWS` 增加 `"chat"`，`VIEW_META` 增加标题/图标，LaunchPad 与「+」菜单加一项。因为标签页保持挂载，聊天面板在切标签时**不会丢历史**。
2. 新增 `SideChatView.tsx`：
   - 内部渲染一个 `TerminalPanel sessionKey={draftPath}` —— 直接复用现有 xterm/OSC/replay 全套管线；
   - 下面挂一个**精简版 Composer**：`Composer` 的 props 已经足够（`sessionPath/status/activity/model/.../onSubmit/onInterrupt`），只需换一个 `onSubmit`（指向草稿路径）并隐藏回灌类按钮；
   - 绑定对象是「打开面板时的 activePath」，之后用户切会话不改变这个绑定。
3. `App.tsx`：状态 `sideChat: { draftPath, parentPath } | undefined`；打开时先确保父会话仍在运行（`runtime.start` 已由 `activate` 保证）。

### 4.5 必须处理的副作用（容易漏）

| 现象               | 原因                                                                                                                                               | 处理                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 主 TUI 被隐藏      | 同窗口内两个 fullscreen TUI：xterm 各自是独立状态机，但**主 TUI 的 pi 进程收不到 resize，渲染是定格的**；它仍在后台正常跑推理                      | 面板打开时给主终端一个「paused/隐藏」态（暂停喂数据 + 覆盖提示）；关闭面板时对主会话触发一次 refit/resize 以恢复画面                             |
| 窄宽度下的字符重排 | 主 TUI 从 120 列压到 ~46 列                                                                                                                        | **已实测**：把 pi TUI 跑在 46×30 的 pty 里，CJK 与框线字符（`\u2500-\u257f`）全部原样存活、无 `??` 缺字痕迹 → 窄宽度只是重排，不会花屏，属可接受 |
| Dock 徽标数字虚高  | `useUnseenRunCompletions` 遍历 **所有** `runtimeStates` 的 key，草稿的 busy→idle 会被计为「未读完成」，而 `setDockBadge(unseenRuns.size)` 直接用它 | 草稿状态不进 `runtimeStates`（独立 state map），或在 hook 里按已知 session 集合过滤                                                              |
| 桌面通知误报       | `notifications.observe` 对每个 state 都判断 busy→idle                                                                                              | 同上传入 `isAuxiliary` 标记跳过                                                                                                                  |
| replay LRU 挤占    | `MAX_BUFFERED_SESSIONS = 6`，草稿会占用一个槽位                                                                                                    | 草稿单独计数或不计入 LRU                                                                                                                         |
| 侧栏不显示         | 这是期望行为（`sessions:list` 不含草稿）                                                                                                           | 无需处理                                                                                                                                         |

### 4.6 生命周期

| 事件                    | 行为                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| 关闭面板                | `side-chat:close` → `runtime.stop(draftPath)` + `forget` + 删临时目录  |
| 主会话被 archive/remove | 连带关闭草稿（父会话没了，草稿无意义）                                 |
| 应用退出                | 现有 `before-quit` → `runtime.stop()`（无参数=停全部）已覆盖草稿       |
| 用户切会话              | 面板与草稿**保持存活**（推荐），只有显式关闭才销毁；产品上也可选择卸载 |

---

## 5. 实施步骤（每步可独立验证）

1. **主进程通道**：`PiRuntime.startAuxiliary()` + `--session-dir` 注入 + `side-chat:*` IPC + preload 暴露。
   验证：dev 里手动调 IPC 打开草稿，`tail -f` 看 `<userData>/side-chat/*/` 只出现侧车、无 `draft.jsonl`，`runtime:state` 出现草稿的 running/idle。
2. **种子上下文**：`open` 时 `copyFile(parent.jsonl → draft.jsonl)`（可选开关）。
   验证：草稿起来后问一句「我刚才在做什么」，回答能对上主对话内容。
3. **UI 面板**：`PanelView = "chat"` + `SideChatView`（TerminalPanel + Composer）。
   验证：打字→提交→流式输出；面板尺寸拖动/resize 正常（依赖 `xtermFit` / resize 门）。
4. **副作用收口**：Dock 徽标、通知、replay LRU、主 TUI paused 态与恢复。
   验证：草稿跑完一轮，Dock 徽标不变、无通知；关面板后主 TUI 画面与滚动位置正常。
5. **（可选 V2）回灌**：桥接新增一个纯文本 transcript 侧车（复用侧车写入模式），面板加「发送到主会话」按钮 → `runtime.submit(parentPath, summary)`。

---

## 6. 风险与未验证项

| 风险                                                        | 等级 | 备注                                                                                     |
| ----------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| 同窗口两个 fullscreen TUI 的主 TUI 画面定格                 | 中   | 不影响主进程推理，但需要「paused + 恢复 refit」的收尾，属新增机制                        |
| 桥接侧车写入链被毒化（目录不存在）                          | 中   | spawn 前 `mkdir -p` 即可规避；建议加单测断言草稿目录存在                                 |
| 草稿 `--session-dir` 与用户 `/new` 的交互                   | 低   | 隔离目录兜底，最坏情况是临时目录里多一个文件，随关闭一起删                               |
| pi 未来改动 `open()` 的非持久化语义                         | 中   | 目前为「打开不存在的路径 → 内存 + 保留显式路径」，是隐藏契约；需加回归测试与版本兼容检查 |
| 上下文一次性快照（不跟随主对话新增消息）                    | 低   | 产品语义可接受；若要跟随，需在提交前重建草稿（成本高，不建议 V1 做）                     |
| Composer 复用（`/e-pi-attach`、skill 包装）在草稿会话的行为 | 低   | 机制与主会话一致（同一 bridge），主要验证图片粘贴路径                                    |

---

## 7. 结论回顾

- **能做，而且成本比预期低**：核心是「草稿路径 + 隔离 session-dir」这一招，实测证明既能瞒过 `listAll()`、又不落盘、且现有就绪探测与侧车机制完全兼容。
- **最大的非显然成本不在 pi，而在 e-pi 自己的单活跃会话假设**：`#activeSessionPath`、`runtimeStates` 驱动的 dock 徽标/通知、以及「主 TUI 被隐藏」的渲染收尾——这三处是设计时必须显式处理的地方。
- 若要做得更「像聊天」（markdown 气泡、工具调用卡片、可复制历史），那是方案 B（RPC/SDK + 原生 UI）的领域；方案 A 可以在不返工主进程的前提下原地升级，因为会话生命周期的抽象（辅助会话通道）是两者共用的。
