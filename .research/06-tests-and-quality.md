# Tests and Quality

E-Pi has 45 Vitest files (~7,100 LOC, ~405 `it()` cases) against ~8,200 LOC of `src/lib` and ~7,400 LOC of Electron services, all in a bare `environment: "node"` (`vitest.config.ts:5`). No CI runs the suite, and coverage is concentrated in pure-function and state-machine units: the terminal resize/replay/viewport cluster is 14 files and roughly a third of all cases, because that is where the shipped bugs were. There is no coverage instrumentation, no DOM/component test and no test across the preload IPC boundary; `pi-runtime.ts` (812 LOC) is exercised only indirectly, and two "compatibility" files fetch npm tarballs and run real `npm install` at test time (`test/pi-tui-runtime-hooks.test.ts:120-191`).

## Findings

### 1. Inventory by subsystem, and the invariant each group encodes

- **Terminal resize / replay / viewport (14 files, ~4,400 LOC)** — the real core. Invariants: output must never reach xterm at a grid it was not rendered for, and a full redraw must never yank a scrolled-up viewport. `xtermResizeScheduler.test.ts:143-431` (18 cases) drives a fabricated rAF queue and asserts ordering ("reverses before the old direction is acknowledged"); `terminal-resize-output-gate.test.ts:105` asserts the gate _rejects_ a late frame "from the wrong grid before writing any of it"; `xterm-scrollback-guard.test.ts:64-85` encodes a real race fix — the old queue-time guard let 3J through and the late parse yanked the viewport.
- **Pi compatibility / packaging (4 files)** — patches must apply to _published_ Pi tarballs, and a rejected update must leave the previous install intact (`pi-update-service.test.ts:106`).
- **fs-backed services + renderer state (11 files)** — round-trip, and corrupt input degrades to defaults (`app-settings-service.test.ts:24-42`, `session-service.test.ts:161-181`, `model-visibility.test.ts:125-138`).
- **Renderer pure libs (16 files)** — `file-tree`, `format`, `mentionReferences`, `textAttachments`, `workspacePreviewKind`, `tokenPreset`.
- **Bridge / Pi extension (3 files)** — `resources/e-pi-bridge.ts` is hand-loaded with a fake `pi` object (`e-pi-bridge-attach.test.ts:9-26`); the regression is explicit: "A basename-only label makes read tools open {cwd}/shot.png and ENOENT" (`:59`).
- **Ranking tables (2 files)** — `open-with-rank.test.ts:81` demotes QuickTime for TypeScript "even though .ts is also MPEG-TS" — a user-visible bug frozen as a table.

### 2. Test-to-source coupling, and what is structurally untestable

- Only **38 source modules** appear in any test. No test imports `electron/preload/index.ts`, `electron/main/index.ts`, or `src/types/contracts.ts` (only two `import type` hits: `format.test.ts:13`, `runtime-state-equality.test.ts:4`). The **88 `ipcMain.handle` registrations vs 124 preload-exposed channels are completely unverified** — a rename on one side ships as a runtime `TypeError`.
- **Untestable as configured:** all 78 `.tsx` components, all 13 hooks, `src/App.tsx` (804 LOC), and anything needing a DOM — `src/lib/appearance.ts`, `editorSettings.ts`, `theme.ts`, `terminalBufferFeeder.ts` all touch `window`/`document`. Also unreachable: real xterm WebGL, real PTY, `node-pty`, real `BrowserWindow`.
- Services importing `electron` and only partially mocked: `agent-config-service`, `app-launch-service`, `package-service`, `pi-agent-loader`, `pi-runtime`, `project-service`, `workspace-watcher-service`, `npm-path`, `debug-log`.

### 3. Coverage gap table — modules with no test file

| Module (LOC)                                                             | Risk if broken silently                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `services/pi-runtime.ts` (812)                                           | Session lifecycle, PTY spawn/kill, output batching, restart-on-update; regressions surface as hung sessions.             |
| `services/app-launch-service.ts` (355)                                   | macOS `.app` scanning; degrades to an empty Open With list.                                                              |
| `main/index.ts` (740)                                                    | 88 IPC handlers, window lifecycle, `renderer:log` wiring; untouched by tests.                                            |
| `preload/index.ts` (271)                                                 | The whole `window.ePi` surface; a typo is a runtime failure on click.                                                    |
| `services/package-service.ts` (243)                                      | Package install/remove; corrupt install breaks sessions.                                                                 |
| `services/pi-agent-loader.ts` (194)                                      | Resolves the Pi entrypoint; wrong path fails every session start.                                                        |
| `services/workspace-watcher-service.ts` (194)                            | `classifyWatchEvent` is tested, the watcher wiring/debounce is not.                                                      |
| `services/side-terminal-service.ts` (180)                                | PTY spawn + `stty` sizing; only the pure `isInteractiveForeground` helper is tested.                                     |
| `services/project-service.ts` (135)                                      | Registry read/write; `resources` helpers tested, service not.                                                            |
| `services/agent-config-service.ts` (87)                                  | Writes Pi agent config; silent clobber risk.                                                                             |
| `npm-path.ts` (105)                                                      | PATH resolution for spawned Node/npm; failure kills every package op.                                                    |
| `services/debug-log.ts` (41)                                             | Discards all errors by design (§5).                                                                                      |
| `src/lib/codeEditorLanguages.ts` (162)                                   | Language mapping; wrong grammar, wrong mode, no signal.                                                                  |
| `src/lib/appearance.ts` (146), `theme.ts` (78), `editorSettings.ts` (92) | Theme/persistence; DOM-coupled, never executed.                                                                          |
| `src/lib/diffPreload.ts` (75), `terminalTheme.ts` (58), `xterm.ts` (39)  | xterm/diff wiring; runtime-only.                                                                                         |
| `src/hooks/*` (748), `src/App.tsx` (804)                                 | All session/project/composer orchestration; 0%.                                                                          |
| `resources/e-pi-bridge.ts` (902)                                         | Only attach, workspace note, theme and dialog cap are tested; telemetry sidecar, `e-pi-thinking`, editor wiring are not. |
| `src/lib/fsErrors.ts` (33)                                               | The single parse point for every renderer error message; untested.                                                       |

### 4. Fragile tests: timing, races, platform, network

- **Real sleeps into an async parser.** `xterm-scrollback-guard.test.ts` sleeps 16 times (30–50 ms) because "xterm parses `write()` asynchronously (setTimeout)" (`:8-12`). Under load the assertion can read a stale buffer — a flake that mimics a product bug.
- **Network + `npm install` inside a unit test.** `pi-compatibility-service.test.ts:349-400` fetches tarballs with a 60 s timeout and 300 s hook; `pi-tui-runtime-hooks.test.ts:120-191` also runs real `npm install` and `tar`. Offline, both `console.warn` and `return` (`:405-408`, `:208-211`) — **the assertions that exist specifically to catch patch drift pass vacuously**.
- **Wall-clock budget.** `terminal-replay-buffer.perf.test.ts:167` asserts 3000 chunks < 60 ms and < 20 µs/chunk; its own comment concedes the threshold is hardware-sensitive. A loaded runner fails falsely.
- **Self-referential fakes.** `xterm-resize-scheduler.test.ts:42-63` reimplements `requestAnimationFrame` via `vi.stubGlobal`; the test asserts against its own scheduler model, so real rAF/timing interactions cannot be reproduced.
- **Platform behaviour is asserted nowhere.** `process.platform` branches exist in `app-launch-service.ts:22-24` (`/Applications`), `side-terminal-service.ts:76-120`, `npm-path.ts:20-42`, `main/index.ts:175-179` (Open With returns `[]` off macOS). `open-with-rank.test.ts` feeds synthetic app lists, so the only platform-flavoured test never reads `process.platform`; Windows is unverified.
- **Order sensitivity.** `session-service.test.ts:96` and `notification-service.test.ts:173` use real `setTimeout` settle waits alongside module-level caches reset in `afterEach` (`quick-commands.test.ts:25`).

### 5. Observability and error-handling posture

- **Debug logging is off unless the user sets `E_PI_DEBUG=1`** (`debug-log.ts:8`), then appends to `~/.e-pi-debug.log` (`:11`, `:29`) truncated once at startup (`:16-23`). Nothing in the app or docs sets or exposes it — the only references outside the module are dev notes (`docs/plan-terminal-performance.md:220`). **No log viewer, no support bundle.**
- **Logging is narrow:** 42 `debugLog` calls — 18 in `pi-runtime.ts`, 10 in `main/index.ts`, 8 in `pi-update-service.ts`, 6 in `side-terminal-service.ts`; the other ~20 services log nothing.
- **Swallowing is pervasive.** `debug-log.ts:20-22`/`:30-32` discarding errors is correct, but the same shape appears where it matters: `pi-runtime.ts:767-768` (watch unsupported → activity silently `undefined`), `pi-settings-service.ts:100-101` (theme sync fails → "light mode falls back to dark", no signal), `pi-runtime.ts:110-111`, `workspace-watcher-service.ts:189-190`, `side-terminal-service.ts:161-172`, `git-service.ts:182-183`, `npm-path.ts:101-102`, `model-service.ts:680-681`; a literal empty catch at `app-launch-service.ts:279`.
- **User-facing surfacing is inconsistent.** Most renderer handlers raise `setError` + `toast.error` (`App.tsx:174`, `:273`, `:312`, `:351`, `:378`, `:588`), but several only set a global `error` with no toast (`:325`, `:336`, `:398`, `:575`), partly intentional (`main/index.ts:166`). Main only hears renderer failures via `console.error` (`main/index.ts:593`, `:604`), and **no `uncaughtException` / `unhandledRejection` / `render-process-gone` handler exists anywhere** — a main-process crash is a silent app death.
- **Error taxonomy is stringly typed.** `fsErrors.ts:8` re-parses `[E-PI-FS:CODE]` out of `Error.message` because "Electron's ipc invoke serialization only preserves `message`" — and it has no tests.

### 6. Tooling

- Verification is commit-only: `.husky/pre-commit` runs `npx lint-staged` + `npm run typecheck`; `package.json:17` gates `build` on typecheck + test. There is **no `.github` directory**, so nothing runs the suite on a second machine or OS.
- `.oxlintrc.json` enables correctness/suspicious (error) and perf (warn) only; no empty-catch rule; the one custom rule is cosmetic `no-underscore-dangle`.
- `npm run test:notif` (`package.json:26`) is a manual `osascript` smoke script (`scripts/test-notification.sh`), not an automated test; macOS notification permissions have no regression coverage.

## Risks

1. **High — `pi-runtime.ts` (812 LOC, the app's spine) has zero direct tests.** PTY spawn/kill, resize signalling, output batching and restart-after-update are covered only indirectly. The most-instrumented service is the one with no assertions.
2. **High — the preload/main IPC contract is unverified.** 88 `ipcMain.handle` vs 124 preload channels, no test importing either side. A rename ships as a runtime `TypeError` visible only when the user clicks that control.
3. **High — the two compatibility files silently no-op offline** (`pi-compatibility-service.test.ts:405-408`, `pi-tui-runtime-hooks.test.ts:208-211`). The checks written to catch patch drift against published Pi tarballs — the 0.85.1 breakage cited at `pi-compatibility-service.test.ts:337-340` — pass vacuously on any network-less or sandboxed runner.
4. **Medium — the flake budget is real and unbounded.** 16 real sleeps in `xterm-scrollback-guard.test.ts`, a wall-clock `<60 ms` assertion (`terminal-replay-buffer.perf.test.ts:167`), and `vi.stubGlobal`-faked rAF mean terminal and CI load will produce intermittent failures that cannot be told apart from regressions.
5. **Medium — silent degradation on paths users would want reported.** `pi-runtime.ts:767` (activity dot), `pi-settings-service.ts:100` (theme sync), `workspace-watcher-service.ts:189` (watching), `app-launch-service.ts:279` (empty catch) all discard the cause, and `E_PI_DEBUG` is undocumented and unreachable from the UI.
