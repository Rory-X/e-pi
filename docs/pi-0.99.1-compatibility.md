# Pi 0.99.1 的 E-Pi 补丁适配

核对日期：2026-09-30。对照官方 npm 发布包的 0.87.1 与 0.99.1，并验证 0.99.0。

结论：保留 E-Pi 的虚拟滚动、外部输入框布局和会话导航，新增 0.99 专用补丁；不能只放宽版本限制。已经完成源码适配，升级到 0.99.1 可以继续开启 TUI 优化。

## 版本跨度与拒绝升级的原因

npm 的正式版本序列是 `0.87.0 → 0.87.1 → 0.99.0 → 0.99.1`，并没有中间的 0.88–0.98 正式发布包。0.99.0 集中了 MCP、codemode、system 主题、滚轮加速等变化；0.99.1 主要增加 GPT-6.1 Sol 并修复 OpenAI 登录打包问题。

截图中的提示来自兼容性保护：此前最新 profile 是 0.87，只允许下一条 minor 版本尝试继承它。0.99 超出了范围，因此更新流程在替换安装目录前要求回退到 stock TUI。这个保护应该保留，因为上游确实修改了补丁依赖的接口。

## 源码变化与处理方式

| 位置                          | 0.99 的变化                                                                                         | E-Pi 处理方式                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `chat-viewport.js`            | 与 0.87.1 相同                                                                                      | 保留外部输入框的 dock 和状态、widget 随正文滚动的布局         |
| `scroll-view.js`、`layout.js` | 与 0.87.1 相同                                                                                      | 保留按块缓存、可见区渲染、宽度切换、空闲补全和锚点恢复        |
| `tui-alt-screen.js`           | `routeWheel(event)` 改为 `routeWheel(event, delta)`；行数由 `WheelScrollAccelerator` 在输入阶段计算 | 宿主精确行数直接传为 `delta`，原生事件保留上游加速与 Alt 倍率 |
| `tui-alt-screen.js` 构造器    | 删除 `wheelScrollLines` 字段，改为 accelerator 对象                                                 | 删除旧补丁对默认行数的覆盖，使用上游设置和默认策略            |
| `markdown.js`                 | 增加只依赖文本的 `cachedTokens`，跨主题、宽度失效复用解析结果                                       | 在新字段旁加入 E-Pi 的失效 revision，不覆盖或清空 token 缓存  |
| `tui.js`                      | 增加完整终端颜色查询、修复鼠标转发后的焦点与退出后的光标                                            | 仅保留 Container 的失效 revision 补丁，保留这些上游改动       |
| `interactive-mode.js`         | 新主题生命周期、ThemedText、内置扩展等变化                                                          | 按 0.99.1 源码重新生成导航与 widget 标记的 diff，保留上游实现 |

旧 runtime hook 也有接口问题：它临时覆盖 `wheelScrollLines` / `getWheelScrollLines()` 来把宿主行数传给旧版，但 0.99 已经不读取这些成员。现在 hook 根据 routing 方法的参数数目适配两条路径：新版直接传递 delta，旧版继续调用旧接口。关闭优化时也完整透传参数，避免新版收到 `undefined` delta。

## 本次实现

- 新增 `@earendil-works__pi-coding-agent@0.99.1.patch` 和 `@earendil-works__pi-tui@0.99.1.patch`，均对照 0.99.1 原始 dist 重新生成。
- 注册 0.99 profile，并检查新的精确滚动表达式；两份补丁进入 `build.extraResources`。
- 保留事务式应用、完整探针检查和失败回滚；未验证的远期版本仍受版本边界保护。
- 修复 hook 的新接口调用与参数透传。宿主滚轮不修改 accelerator 的手势历史，原生滚轮继续使用上游速度计算。
- 磁盘补丁已经发送视口、导航 OSC 时，hook 直接调用原 renderer，消除重复视口上报与额外帧捕获。
- 将相同的虚拟滚动行为测试同时运行在仓库自带的 0.84.2 和真实发布的 0.99.1 上。

## 验证

- 完整 Vitest：46 个测试文件、437 项测试通过。
- 真实发布包：0.84.2、0.85.0、0.85.1、0.86.0、0.86.1、0.87.0、0.87.1、0.99.0、0.99.1 的补丁应用、探针、幂等和原生 dock 保留检查通过。
- 实际更新服务下载 0.99.1、安装依赖、应用补丁并原子替换测试目录，`fallbackToStock: false`。
- sidecar Node 加载真实 0.99.1：宿主发送 5 行就滚 5 行；原生固定 3 行、Alt 15 行；自动加速保留，宿主输入不污染手势状态。
- 两层兼容机制同时加载时，每帧只发送一份视口与导航数据，导航点击可跳回首条消息；payload 的终端控制字符仍被过滤。
- 长会话缩放、尾部跟随、锚点稳定、过期补全取消、缓存复用、文本失效、动态 widget 与固定交互区测试通过。
- 隔离的真实 PTY 会话加载完整 CLI 与 E-Pi bridge 成功，报告 idle；主题切换、宿主滚动及终端缩放后进程正常，产生 8 帧视口上报，无加载错误。使用临时 agent 配置，无模型请求。
- TypeScript、修改文件的 oxlint、Electron Vite 构建通过；打包前检查确认 5 条 profile 和 11 份补丁一致。

## 使用与后续优化

2026-10-08 更新：仓库默认依赖和锁文件已统一固定到 0.99.2，补丁按 0.99.2 正式发布包重新生成并注册。新安装包直接内置 0.99.2，无需先通过应用内更新升级；打包前与打包后都会核对实际 Pi 版本。原有 0.99.1 升级兼容支持继续保留。已经选择 stock TUI 的安装，可在设置中重新开启 TUI 优化。

后续减少维护面的优先方向是明确每项功能的单一实现入口：虚拟布局继续使用结构补丁；输入协议、OSC 和导航尽量通过导出类的方法包装完成。目前仍保留磁盘补丁里的协议实现作为 preload 缺失时的兼容路径，因此先让 hook 避免重复处理。若要彻底删去这些 diff，需要同步加强 preload 的存在性及启动行为验证，不能仅删除 marker 探针。

0.99 新增的 MCP/codemode 设置入口、system 主题选择和虚拟模型展示可以分别迭代。现有 bridge 的编辑器、主题对象、会话及工具事件接口仍可使用；E-Pi 的 light/dark 主题配对也仍被上游支持。

## 官方资料

- [Pi 0.99.1 对应源码](https://github.com/earendil-works/pi/tree/d86654abb8862e201933517d6f1fce9f88dd117f)
- [该版本 Changelog](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/coding-agent/CHANGELOG.md)
- [pi-coding-agent 0.99.1 发布包](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.1.tgz)
- [pi-tui 0.99.1 发布包](https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.99.1.tgz)
