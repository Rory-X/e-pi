# E-Pi — Electron Main Process & IPC

## Summary

E-Pi's main process is a single 740-line bootstrap file (`electron/main/index.ts`) that owns 13 service
singletons and registers **98 IPC channels** (88 `ipcMain.handle` + 10 `ipcMain.on`) inside one imperative
`registerHandlers()` (index.ts:129-563). A thin preload (`electron/preload/index.ts`, 271 lines) mirrors that whole
surface as `window.ePi`, typed by the hand-written `EPiApi` interface (contracts.ts:614). Every channel name is a
**raw string literal duplicated across both files** — no shared constants, no parity test — held in sync only by a
type that names methods rather than channels. Sandbox posture is correct (`contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, index.ts:578-583), but the bridge is deliberately broad: workspace
confinement is measured against a renderer-supplied root, so the renderer can read and write arbitrary paths.

## Findings

### Bootstrap and lifecycle

- Window: 1440x920, min 1140x620, `titleBarStyle: "hiddenInset"` on darwin, background matched to
  `nativeTheme.shouldUseDarkColors` to avoid first-paint flash (index.ts:565-584). `mainWindow` is a mutable
  module-level `let` (index.ts:73); `closed` merely nulls it (index.ts:626-628) — no session or terminal teardown.
- Dev vs prod: dev loads `process.env.ELECTRON_RENDERER_URL`, prod `loadFile("../renderer/index.html")`
  (:608-612). Dev-only: console piping, a `did-finish-load` `executeJavaScript` probe (:591-606), and a separate
  userData dir (`userData + "-dev"`, :699-701) so `pnpm dev` does not collide with the packaged app's instance lock.
- `requestSingleInstanceLock()` gates the whole app; `second-instance` restores/focuses (index.ts:703-711).
  `whenReady`: `resetDebugLog()` → `ensureNpmOnPath()` → `registerHandlers()` → `cleanupStalePastedImages()` →
  `createWindow()` (index.ts:713-729).
- Teardown is fire-and-forget and incomplete: `before-quit` calls `void runtime.stop()` without awaiting, then
  `sideTerminals.killAll()` and `workspaceWatcher.dispose()` (index.ts:731-735). `GitService.unwatch()` and
  `OutputBatcher.dispose()` are **never called**; `runtime.stop()` returns before the PTYs die, so quitting during a
  run can orphan pi processes.
- `npm-path.ts` (105 lines) prepends a resolved npm dir to `process.env.PATH` (npm-path.ts:17-26), preferring the
  bundled sidecar node, then PATH dirs, then nvm/fnm/asdf/volta/brew/APPDATA (npm-path.ts:66-83).
  `bundledNodeBinDir()` returns undefined unless `app.isPackaged` (npm-path.ts:35).

### Service layer (electron/main/services/, 26 files / 7430 LOC)

- **pi-runtime.ts** (812) — the core. `PiRuntime` owns a `Map<sessionPath, Instance>` of node-pty processes; API is
  `start/stop/write/submit/interrupt/resize/reloadAll/forget/isRunning/getStates/setThemeHint/broadcastTuiTheme`
  plus `onState/onGlobalData/onSessionFileChanged` registries (pi-runtime.ts:148-252). Lifecycle ops are serialized
  per session via `#chains` (pi-runtime.ts:356-367). Readiness polls a `<session>.e-pi-activity.json` sidecar every
  25ms with a 30s deadline re-armed on each PTY chunk (pi-runtime.ts:573-617). Node/entry/bridge/preload paths are
  resolved by existence, not by `app.isPackaged` (pi-runtime.ts:51-99).
- **model-service.ts** (779) — model/provider catalog and login (`login/respondToLogin/cancelLogin/logout/setDefault`
  /custom-provider CRUD/`fetchModels/catalogMeta`). Single-flight guard `#loginController` (model-service.ts:313,318).
  `fetchModels` `fetch()`es a renderer-supplied `baseUrl` with the user's apiKey (model-service.ts:609-623).
- **git-service.ts** (472) — `git` via `execFile`, 60s timeout, 4MB maxBuffer (git-service.ts:104-110). At most
  **one** watched repo at a time (`#watchedCwd`, git-service.ts:223-245), 600ms trailing / 2s hard debounce. Includes
  an in-process LLM commit-message generator using pi's `ModelRuntime` with a 120s abort (git-service.ts:433-444).
- **pi-compatibility-service.ts** (406) — patches the on-disk pi package to match the TUI-optimization mode;
  `canLoadPiPackage`/`preparePiPackageForMode`/`applyPiCompatibilityPatches` (…:324,335,384).
- **app-launch-service.ts** (355) + **open-with-rank.ts** (321) — macOS `.app` enumeration and ranked Open-With; the
  pure-ranking half is unit-tested, the OS-facing half untested by construction.
- **pi-agent-loader.ts** (194) — single source of truth for the pi package dir and for ESM-loading it from real disk
  instead of the asar stub; `loadPiAgent()` caches a dynamic import, clearing on failure (pi-agent-loader.ts:186-193).
  Rationale documented at pi-agent-loader.ts:11-23: in-place pi updates swap `app.asar.unpacked`, so a static import
  would keep loading stale asar entry code.
- **command-service.ts** (350) — builtin + template + plugin slash commands, per-cwd caches for jiti-compiled
  extensions (command-service.ts:117-124).
- **file-service.ts** (343) — workspace fs API. `FsBridgeError` smuggles a machine-readable code into
  `Error.message` as `[E-PI-FS:CODE]` because Electron preserves only the message (file-service.ts:36-47); the
  renderer re-parses it. Atomic temp+rename writes with optional `contentHash`/`mtimeMs` staleness checks
  (file-service.ts:243-283).
- **session-service.ts** (297) — pi JSONL sessions plus a Codex-style archive index in userData, written
  temp-then-rename on a serialized chain (session-service.ts:198-208).
- Smaller: **package-service** (243), **skill-service** (233), **workspace-watcher-service** (194),
  **side-terminal-service** (180) + **side-terminal-interactive** (154), **project-service** (135),
  **notification-service** (130), **output-batcher** (104), **agent-config-service** (87),
  **app-settings-service** (81), **debug-log** (41).

### IPC surface

- One flat function: no router, no per-service `register*`, no channel table. Handlers call service methods and
  re-derive the cwd via `activeCwd()` (index.ts:80-84) whenever the renderer passes a falsy one — `git:status`
  (index.ts:427-430), `fs:*` (:458-477), `packages:*` (:405-413).
- Channel names are raw strings; `grep -rn 'CHANNEL' src/types electron/` returns nothing. Parity is currently
  perfect (98 registrations vs 98 unique preload channel strings) but unenforced: a renamed channel compiles and
  fails only at runtime as an unreplied `invoke`.
- 11 main-to-renderer pushes from `sendToRenderer` (index.ts:75-79): `git:changed`, `models:login-event`,
  `notifications:open-session`, `packages:progress`, `projects:updated`, `runtime:data`, `runtime:state`,
  `sessions:updated`, `side-terminal:data`, `window:fullscreen-changed`, `workspace:changed` — all consumed in
  preload (5 via the `subscribe()` helper at preload/index.ts:63-67, 6 inline). It broadcasts to **every** window.
- Fire-and-forget `ipcMain.on` (no reply, errors vanish): `app:log`, `runtime:write`, `runtime:interrupt`,
  `runtime:resize`, `models:login-response`, `models:cancel-login`, and four `side-terminal:*` writes
  (index.ts:293, 395, 400-403, 489-496).

### Preload bridge

- `contextBridge.exposeInMainWorld("ePi", api)` (preload/index.ts:271); `api` is annotated `: EPiApi`, so a
  missing or renamed _method_ is a compile error. `webUtils.getPathForFile` is re-exported raw (:83).
- Error handling is absent: 88 bare `ipcRenderer.invoke(...) as Promise<T>` casts, no wrapping, no `Result` type.
  Rejections arrive as `Error` carrying only the main-process message — which is precisely why file codes are
  string-encoded; `FsBridgeError.code` never crosses the boundary.
- Leaky abstractions: `app.imageData(filePath)` (index.ts:332-352, no confinement check) and
  `fs.readWorkspaceBinary` return **base64 data URLs** of arbitrary-size files over IPC, up to the 32MB
  `PREVIEW_MAX_BYTES` cap (file-service.ts:24) serialized in a single message.

### Coupling, order, global state

- 12 module-level singletons constructed at import time (index.ts:62-72). `PiRuntime` is built before
  `app.whenReady()` and its constructor calls `readThemeHint()` → `app.getPath("userData")`
  (pi-runtime.ts:176-178, 101-114), coupling module init to Electron's lifecycle.
- `pi-agent-loader.ts` is the hub: 7 services import it, and it imports `app-settings-service` +
  `pi-compatibility-service` (pi-agent-loader.ts:8-9) — so `piPackageDir()` can **throw** from unrelated services
  (pi-agent-loader.ts:80, 103) whenever the on-disk package does not match the selected TUI mode.
- Listener wiring sits at module scope, outside `whenReady` (index.ts:631-694): `runtime.onGlobalData`,
  `runtime.onState`, `runtime.onSessionFileChanged`, `projects.onUpdated`, `packages.setProgressListener`, plus a
  second `runtime.onState` feeding notifications (:688-693). By contrast `sideTerminals.onData` and
  `workspaceWatcher.onChanged` are wired _inside_ `registerHandlers()` (:485, :497) — two conventions in one file.
- Untracked module state: `notificationHintShown` (index.ts:655), `sessionListRefreshTimer` (:638).
  `PiRuntime.setActiveSession()` has no caller in `index.ts`; the active session used by `activeCwd()` is set only
  as a side effect of `runtime.start()` (pi-runtime.ts:256) — stale after reloads.

## Risks

1. **High — untyped, duplicated channel strings.** 98 channels as literals in two files, no shared constant, no
   parity test. Renaming one compiles cleanly and fails only at runtime. Evidence: no channel constant exists;
   `EPiApi` types methods, not channels (contracts.ts:614+).
2. **High — no IPC argument validation and no sender checks.** Handlers trust the renderer: `git:commit` takes a raw
   message, `app:open-path` opens any path, `app:image-data` reads any readable file (index.ts:332) with no
   `isInside` guard, and `fs:*` confines only _relative to a renderer-supplied `cwd`_ (file-service.ts:65-73).
   There is zero `event.senderFrame`/`sender` validation in `electron/`. `sandbox: true` limits a compromised
   renderer's blast radius but does not make this surface safe.
3. **High — lifecycle leaks and missing teardown.** `before-quit` never awaits `runtime.stop()` (index.ts:732);
   `OutputBatcher.dispose()` and `GitService.unwatch()` are unreachable from shutdown; `mainWindow.on("closed")`
   tears down nothing (:626). `#chains` (pi-runtime.ts:166) and `#instances` entries beyond `forget()` grow
   unbounded within a session.
4. **Medium — swallowed errors at scale.** 64 bare `catch {}` blocks in `electron/main/`. Many are deliberate
   best-effort, but several hide real failures: `sideTerminals.resize` (side-terminal-service.ts:161), untracked-file
   reads in git (git-service.ts:417), `ensureWatchedDirs` (workspace-watcher-service.ts:189), and
   `sessionListRefreshTimer`'s `.catch(() => undefined)` (index.ts:646), which silently stops sidebar refreshes.
5. **Medium — `FsBridgeError.code` does not cross IPC.** Only `Error.message` survives, so typed codes ride as an
   `[E-PI-FS:CODE]` prefix parsed back in the renderer (file-service.ts:36-47); changing the prefix silently breaks
   all renderer error classification. `writeText` throws `FsBridgeError` on some paths and raw `Error` on others
   (file-service.ts:252 vs :258).
6. **Medium — `mainWindow!` in dialog handlers.** `app:choose-directory/-directories/-files` pass `mainWindow!`
   (index.ts:229, 237, 245). On macOS `window-all-closed` is a no-op (:737), so the window can be gone while the app
   lives and the dialog call throws on `undefined`.
7. **Medium — singleton and module-init coupling.** Services are constructed at import (index.ts:62-72) and listeners
   attach outside `whenReady` (:631); `PiRuntime`'s constructor touches `app.getPath` before ready
   (pi-runtime.ts:176). With no DI seam, main-process code is testable only by mocking the `electron` module — indeed
   `test/` has no IPC or preload test at all.
8. **Low — broadcast-to-all-windows pushes.** `sendToRenderer` loops every `BrowserWindow` (index.ts:75-79);
   single-window today, but `window:fullscreen-changed`, `notifications:open-session` and `runtime:state` would be
   misrouted with a second window.
9. **Low — base64 binaries over IPC.** `app:image-data`/`fs:read-workspace-binary` serialize data URLs across the
   bridge (index.ts:332-352), unbatched, cost scaling with file size.
10. **Low — three copies of the traversal guard.** `isInside` (file-service.ts:49), `insideTemp`
    (index.ts:275-277) and `toRelativePath` (workspace-watcher-service.ts:101-106) each reimplement the same
    "is this path inside that root" check with different edge-case handling.
