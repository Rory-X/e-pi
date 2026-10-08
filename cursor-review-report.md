FINAL_REPORT 开头的最终审查报告正文。FINAL_REPORT

## P0

### 1. `app:remove-temp-file` 路径校验可被 `..` 绕过，可删除临时目录外文件

- **位置**：[`electron/main/index.ts`](electron/main/index.ts):270-274
- **触发条件**：渲染进程调用 `removeTempFile`，传入形如 `` `${tempDir}/../../../任意路径` `` 的字符串（前缀仍匹配 `` `${tempDir}/` ``）。
- **因果链**：校验只用 `path.startsWith(`${tempDir}/`)`，未 `resolve`/`realpath` 后再做“必须位于 temp 内”判断；`rm(path, { force: true })` 会解析 `..` 并删除解析后的目标。注释声称“refuse paths outside the temp dir”，实现未兑现。
- **影响**：在渲染进程被 XSS/注入或恶意前端代码利用时，可删除用户机器上任意可写路径（高危任意文件删除）。
- **修复建议**：对入参 `resolve` 后用与 `file-service.isInside` 相同的包含关系判断；仅允许删除本应用写入的前缀文件（如 `mermaid-`）；禁止未规范化路径。

## P1

### 2. 多仓文件树可浏览 sibling，但打开预览/编辑器用错 `cwd`，必失败

- **位置**：[`src/App.tsx`](src/App.tsx):436-446；[`electron/main/services/file-service.ts`](electron/main/services/file-service.ts):67-72；[`src/components/workspace/ToolPanel.tsx`](src/components/workspace/ToolPanel.tsx):220；[`src/components/workspace/FileTreeView.tsx`](src/components/workspace/FileTreeView.tsx):62-70,350-365
- **触发条件**：多仓 project（`repos.length > 1`）中，在 Files 面板打开非当前 session `cwd` 的 sibling 仓库文件（Preview / Open in Editor）。
- **因果链**：`FileTreeView` 用各 root 的绝对路径调用 `listDir(rootPath, path)`，浏览正常；`onOpenFile` → `handleOpenWorkspaceFile` 固定传 `{ cwd: activeCwd, path: siblingAbs }`；`resolveTarget` 要求 `path` 必须在 `cwd` 内，sibling 触发 `OUTSIDE_WORKSPACE`。
- **影响**：多仓文件树核心交互（打开 sibling 文件）不可用。
- **修复建议**：打开时把 `cwd` 设为包含该路径的 project folder/root（可用 `rootIndexOf` / `folders.find`）；IPC 读文件与 overlay 请求使用同一 root。

### 3. Windows 上 `removeTempFile` 前缀校验与 `join` 返回路径不一致

- **位置**：[`electron/main/index.ts`](electron/main/index.ts):261-274；调用方 [`src/components/workspace/MermaidDiagram.tsx`](src/components/workspace/MermaidDiagram.tsx):159-177
- **触发条件**：Windows 上 Mermaid「打开」导出 PNG 后延迟清理；`writeTempFile` 经 `path.join` 返回反斜杠路径。
- **因果链**：写入用 `join(tempDir, basename)` → `...\\Temp\\mermaid-….png`；删除检查 ``startsWith(`${tempDir}/`)``（正斜杠）→ 恒为 false → 抛错（调用方 `.catch` 吞掉）。
- **影响**：Windows 上临时 PNG 无法按设计清理，残留堆积；与 P0 同一校验逻辑需一并重写。
- **修复建议**：统一 `path.resolve` + 平台无关的 `isInside(tempDir, resolved)`；不要手写 `/` 前缀匹配。

## P2

### 4. 多根文件树宣称“每仓有 watch”，实际只 watch `activeCwd`

- **位置**：[`src/App.tsx`](src/App.tsx):476-483；[`src/components/workspace/FileTreeView.tsx`](src/components/workspace/FileTreeView.tsx):249-267
- **触发条件**：Files 面板展示多个 repo root，且在非当前 session cwd 的 sibling 目录发生磁盘变更。
- **因果链**：`App` 仅 `workspace.watchStart(activeCwd)`；`FileTreeView` 虽按 `rootSet` 过滤事件，但 sibling 根本不会产生 `workspace:changed`。
- **影响**：兄弟仓目录树陈旧，需手动 Refresh 才更新。
- **修复建议**：对 `treeRoots`/`activeProject.folders` 全部 `watchStart`，切换 session 时成对 stop；或删掉误导性注释并接受仅当前仓自动刷新。

### 5. 文件树 `roots` 来自 `gitRepos`，非 git 的 project folder 不会成为根

- **位置**：[`src/App.tsx`](src/App.tsx):115-132,730-732；[`src/components/workspace/FileTreeView.tsx`](src/components/workspace/FileTreeView.tsx):64-70
- **触发条件**：project 含 ≥1 个非 git folder，且 `gitRepos` 结果与 `folders` 不一致；或 session `cwd` 落在非 git folder，而 `repos` 只有其它 git 路径。
- **因果链**：`ToolPanel` 把 `activeProjectRepos`（仅 `.git` 目录）当作 `FileTreeView.roots`；非 git folder 被排除；若 `roots` 非空则不再回退到 `[cwd]`，当前 session 目录可能根本不在树里。
- **影响**：多 folder project 的文件树与 sidebar/project 模型不一致，部分 folder 不可见或当前仓缺失。
- **修复建议**：Files 使用 `activeProject.folders`（或 `folders`∪`[cwd]`）；Review 继续用 `gitRepos`。

## P3

### 6. 新增测试引入未使用导入，导致 lint 失败

- **位置**：[`test/file-tree.test.ts`](test/file-tree.test.ts):6
- **触发条件**：运行 `pnpm lint`。
- **因果链**：`findNode` 被 import 但未使用 → `oxlint` `no-unused-vars` error → lint exit 1。
- **影响**：CI/提交钩子若跑 lint 会红。
- **修复建议**：删除未使用的 `findNode` 导入。

---

## 疑问（证据不足，未标为 finding）

1. **`test/project-workspace.test.ts` / `test/e-pi-bridge-workspace.test.ts`**：导入 `resources/e-pi-bridge` 时因 `@earendil-works/pi-coding-agent` → `undici` 的 `webidl.util.markAsUncloneable is not a function`（Node v20.20.2）导致 suite 无法加载；同环境其它依赖 pi 的测试也有类似失败。是本机 Node/依赖矩阵问题还是变更引入的稳定 CI 回归，本次未完全定性。
2. **Mermaid `innerHTML = result.svg`**：`securityLevel: "strict"` 下是否足以覆盖全部图类型的 XSS，未做对抗样本验证。
3. **`typebox` 放在 `devDependencies`**：运行时由 pi 扩展加载器解析时通常可用；打包/standalone 路径是否永远不需要 e-pi 自带 `typebox`，未在真实 pi spawn 下验证。

---

## 审查范围

- 工作区全部未暂存修改与未跟踪相关文件：多仓 bridge（`E_PI_USER_DATA` / `project_repos` / `before_agent_start`）、多根 `FileTreeView`、sidebar Pinned 拖拽、Mermaid 预览与 temp IPC、文案 workspace→project、样式与 `package.json`/`pnpm-lock` 依赖变更。
- 对照调用链：`App` → `ToolPanel`/`FileTreeView`/`WorkspaceOverlayHost`；`file-service.resolveTarget`；`WorkspaceWatcherService`；`e-pi-bridge` workspace helpers；`MermaidDiagram` ↔ temp IPC。
- 未改任何文件；未执行 git 写操作。

## 验证命令与结果

| 命令                                                                                     | 结果                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                         | 通过（exit 0）                                                                                                                                                   |
| `pnpm lint`                                                                              | 失败：`test/file-tree.test.ts:6` `findNode` unused（exit 1）                                                                                                     |
| `pnpm exec vitest run test/file-tree.test.ts`                                            | 通过：1 file / 13 tests                                                                                                                                          |
| `pnpm exec vitest run test/project-workspace.test.ts test/e-pi-bridge-workspace.test.ts` | 失败：两 suite 在 import 阶段因 `undici`/`markAsUncloneable` 崩溃（0 tests 执行）                                                                                |
| 只读 Node 脚本验证 temp 路径                                                             | macOS：`` `${tempDir}/../..` `` 可通过 naive `startsWith`；Windows：`path.win32.join` 路径不能匹配 `` `${tempDir}/` ``，且 `..\\..` 攻击在反斜杠前缀下同样可通过 |
