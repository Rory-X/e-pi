# E-Pi → Pi Agent Integration (research 02)

## Summary

E-Pi does not embed Pi as a library; it supervises **one `node-pty` process of Pi's CLI per session**, injecting a bridge extension (`--extension`) and an ESM loader preload (`--import`). The preload rewrites Pi/pi-tui modules **in memory**, while a second, older mechanism rewrites the **installed packages on disk** with hand-maintained unified diffs gated by a per-`major.minor` compatibility profile. Telemetry flows back over a JSON sidecar next to the session file plus private OSC/APC escape sequences parsed by xterm. Everything is pinned to Pi `0.84.2` with patches for `0.84.2 / 0.85.0 / 0.85.1`, so an unpatched upstream minor disables the optimization layer rather than failing silently — though several hooks degrade quietly.

## Findings

### 1. Process model and supervision (`electron/main/services/pi-runtime.ts`)

- One process per session file, held in `#instances: Map<sessionPath, Instance>` (pi-runtime.ts:148-166); spawning is lazy and never touches other sessions (pi-runtime.ts:369-394).
- Spawn: `node <dist/cli.js> --session <file> --extension <e-pi-bridge.ts>` plus optional `--import <e-pi-tui-preload.mjs>`, `--tui-mode fullscreen`, and agent args (pi-runtime.ts:415-435; agent args from agent-config-service.ts:72-86).
- Binary is the bundled sidecar Node (`resources/node/bin/node`, v22.23.2) — spawning `process.execPath` makes macOS show a stray Dock icon (pi-runtime.ts:86-99). `PI_NODE_BINARY` overrides.
- Env contract: `E_PI=true`, `E_PI_TUI_OPTIMIZATIONS`, `E_PI_USER_DATA`, `COLORFGBG`, `TERM` (pi-runtime.ts:445-466).
- Lifecycle: `start/stop/reloadAll/forget`, serialized per session by `#chain` (pi-runtime.ts:356-367, 254-291). Stop sends Ctrl-D then `kill()` after 1.5 s (pi-runtime.ts:772-798); `dying` suppresses trailing output.
- Readiness is **not** a protocol handshake: it polls for the bridge's activity sidecar to contain `status: busy|idle` every 25 ms, with a 30 s deadline re-armed on each PTY chunk (pi-runtime.ts:573-617).
- Input: bracketed paste for submit, ESC for interrupt (pi-runtime.ts:313-338); output batched 8 ms/64 KB per session (output-batcher.ts:1-40).
- `reloadAll` kills and respawns every live session — used on auth/model/config changes and after a Pi update (pi-runtime.ts:282-291; electron/main/index.ts:99, 158, 209).

### 2. Package resolution and version pinning

- `loadPiAgent()` dynamically `import()`s `<pkg>/dist/index.js` from disk, bypassing the asar stub; a failed load clears the cache (pi-agent-loader.ts:186-193). Packaged builds resolve `app.asar.unpacked/...`, dev builds prefer `userData/pi-agent` (pi-agent-loader.ts:64-106).
- The main process consumes far more than the CLI: `SessionManager`, `SettingsManager`, `ModelRuntime`, `DefaultPackageManager`, `getAgentDir`, `loadSkills`, `parseFrontmatter`, `CONFIG_DIR_NAME`, `discoverAndLoadExtensions` (session-service.ts:66-100; model-service.ts:271-592; package-service.ts:212-233; command-service.ts:213-282; skill-service.ts:42-230). These are unversioned private APIs.
- Installed version: `0.84.2` (node_modules/@earendil-works/pi-coding-agent/package.json); `package.json:46,57`.

### 3. Update and compatibility

- `checkPiUpdate` hits the npm registry directly with a 10-min cache, never throwing (pi-update-service.ts:16-22, 93-109).
- `applyPiUpdate` downloads the tarball, extracts with system `tar`, deletes `devDependencies`/`scripts`, runs `npm install --omit=dev --ignore-scripts --no-save`, verifies `dist/cli.js`, then performs an atomic `renameSync` swap with backup/restore (pi-update-service.ts:189-289).
- Version-gated workarounds for upstream defects: `UNDECLARED_RUNTIME_COMPANIONS` adds `@earendil-works/pi-server` for 0.85.0 only (pi-update-service.ts:26-85).
- Compatibility layer: profiles keyed by `major.minor` (pi-compatibility-service.ts:68-101); a no-profile version throws (pi-compatibility-service.ts:388-390). Patches are home-grown unified diffs with a 3-line fuzzy locator (pi-compatibility-service.ts:199-240) applied **transactionally** with rollback and a post-write probe check (pi-compatibility-service.ts:282-294, 384-405).
- **What breaks on an upstream change:** a new minor with no profile → `applyPiUpdate` throws `E_PI_TUI_COMPATIBILITY_REQUIRED:<version>` (pi-update-service.ts:23, 255-258), the UI offers "stock fallback" (index.ts:196-216; PiAgentSettings.tsx:182-203) and persists `tuiOptimizationsEnabled=false` (index.ts:202-207). A patch-level drift that fuzzy-matching "absorbs" is the dangerous case: probes only assert marker presence (pi-compatibility-service.ts:26-37, 301-311), not behavior.
- `resources/e-pi-tui-hooks.mjs` was introduced precisely because Pi 0.85.1 renamed `wheelScrollLines`→`getWheelScrollLines` (e-pi-tui-hooks.mjs:9-17).

### 4. Bridge extension (`resources/e-pi-bridge.ts`, 902 lines, TypeScript, loaded by path)

- Registers tool `project_repos`; rewrites the system prompt each turn from the app's `projects.json` (e-pi-bridge.ts:117-166).
- Custom commands: `/e-pi-theme`, `/e-pi-thinking`, `/e-pi-attach` (e-pi-bridge.ts:685-746); host invokes them via `runtime.submit` (pi-runtime.ts:199; Composer.tsx:375, 432).
- Hooks: `session_start`, `model_select`, `thinking_level_select`, `agent_start/agent_settled`, `message_start/update/end`, `session_compact`, `session_shutdown` (e-pi-bridge.ts:748-901).
- Telemetry = `<session>.e-pi-activity.json` written atomically (tmp + rename) next to the session (e-pi-bridge.ts:410-436); the app watches the directory and JSON-parses it (pi-runtime.ts:619-770). Payload includes status, model, thinking levels, context usage, cumulative usage/cost, cache-hit rate, tok/s and `waitingUser`.
- Non-Pi coupling: waits are mirrored from third-party extension event-bus channels `permissions:ui_prompt`, `permissions:decision`, `rpiv:ask-user:prompt`, `rpiv:ask-user:blocked` (e-pi-bridge.ts:455-465, 810-831).
- Also monkey-patches `process.stdout.write` to stamp resize frames (e-pi-bridge.ts:204-228) and `ctx.ui.custom` to cap dialog height (e-pi-bridge.ts:640-653).
- Uses `pi.setThinkingLevel`, `pi.sendUserMessage(..., {deliverAs:"followUp"})`, `ctx.sessionManager.getEntries()`, `ctx.getContextUsage()`, `ctx.ui.setHeader/setFooter/setEditorComponent` — all private surface.

### 5. In-app TUI suppression/customisation — the brittle core

- `e-pi-tui-preload.mjs` calls `register()` unconditionally so a session never fails to start (e-pi-tui-preload.mjs:15-26); each injector re-checks `E_PI_TUI_OPTIMIZATIONS` (app-settings-service.ts:44-52).
- `e-pi-tui-hooks.mjs` appends injector source to two modules by **URL suffix** (e-pi-tui-hooks.mjs:304-307, 326-342). Exact monkey-patched symbols:
  - `TuiAltScreen.prototype.handleViewportInput` — intercepts `\x1b_e-pi:viewport:scrollto|wheel|bottom` (e-pi-tui-hooks.mjs:101-138).
  - `TuiAltScreen.prototype.routeWheel` — temporarily sets own props `this.wheelScrollLines = 1` and `this.getWheelScrollLines` (e-pi-tui-hooks.mjs:146-166).
  - `TuiAltScreen.prototype.doRender` — captures `this.terminal.write`, injects OSC 6973/6974 before `\x1b[?2026l` (e-pi-tui-hooks.mjs:173-213).
  - Reads unexported state: `currentLayout.primaryScrollView`, `implicitScrollView`, `ePiNavBlocks/ePiNavLabels/ePiNavReplies`, `getVirtualBlockOffsets`, `ePiLastContext.renderCache`, `ePiVirtualRenderVolatile` (e-pi-tui-hooks.mjs:108-111, 199-256).
  - `InteractiveMode.prototype.renderWidgetContainer` forced to `spacerWhenEmpty=false` (e-pi-tui-hooks.mjs:290-296).
- The **disk patches** (applied to `node_modules`) add the other half of the private contract: `renderInvalidationRevision` in markdown.js/text.js/tui.js, `renderVirtualViewport`/`scrollToVirtualBlock`/`getVirtualBlockOffsets` in scroll-view.js, `scrollVirtualStart` in layout.js, `EPI_VIEWPORT_OSC_PREFIX`/`EPI_NAV_OSC_PREFIX`/`buildEPiNavOsc` in tui-alt-screen.js (pi-compatibility-service.ts:20-37; patches/@earendil-works__pi-tui@0.85.1.patch:637-746), plus `E_PI_TUI_OPTIMIZATIONS`, `externalComposer`, `ePiVirtualRenderVolatile`, `ePiNavUserMessage` in `chat-viewport.js`/`interactive-mode.js` (pi-compatibility-service.ts:76-100).
- Host side of the protocol: `TerminalPanel.tsx:225-235` registers xterm OSC handlers 6973/6974; encoders in `src/lib/terminalViewportProtocol.ts:1-14,112`.

### 6. Settings and config files

- `~/.pi/agent/settings.json` (or `PI_CODING_AGENT_DIR`): merged writes of `quietStartup`/`hideThinkingBlock` (pi-settings-service.ts:18-61). E-Pi forcibly sets `theme` to `e-pi-light/dark` unless the user picked a non-default (pi-settings-service.ts:71-82) and copies `e-pi-light.json` into `themes/` before every spawn (pi-settings-service.ts:89-103; called at pi-runtime.ts:374-375).
- `userData/agent-config.json` → CLI flags (agent-config-service.ts:26-86); `userData/app-settings.json` → `tuiOptimizationsEnabled` (app-settings-service.ts:16-52).
- Settings UI: `src/components/settings/PiAgentSettings.tsx` — TUI patch switch, quiet startup, hide thinking, thinking level, prompts, version + update flow (PiAgentSettings.tsx:212-268, 157-203).

### 7. Test coverage of this area

- `test/pi-tui-runtime-hooks.test.ts` spawns the real sidecar Node with `--import` against real published Pi 0.84.2/0.85.0/0.85.1 and asserts disk files stay unmodified (pi-tui-runtime-hooks.test.ts:4-9, 26-34, 233-240).
- Also `pi-compatibility-service.test.ts`, `pi-update-service.test.ts` (registry mocked, `PI_PACKAGE_DIR` sandboxed), `pi-tui-virtual-scroll.test.ts`, `pi-update-resolve.test.ts`, `pi-settings-service.test.ts`.
- `test/token-preset.test.ts` is **not** Pi-integration related — it tests `src/lib/tokenPreset` (token-preset.test.ts:3).

## Risks

1. **High — dependency on rewritten upstream internals.** E-Pi mutates `node_modules/@earendil-works/pi-tui/dist/*.js` and `pi-coding-agent/dist/modes/interactive/*.js` in place (pi-compatibility-service.ts:394-405). Any patch-level drift is absorbed by fuzzy matching (pi-compatibility-service.ts:222-240), so a subtly different upstream build can be patched "successfully" while behavior silently diverges. There is no checksum/diff verification of the installed package and no upstream integrity signature on the tarball (pi-update-service.ts:194-197).
2. **High — silent degradation of the runtime hooks.** Injectors match by module URL suffix and a bare global class name and return early if absent (e-pi-tui-hooks.mjs:75-77, 283-287, 330-336). If upstream renames or relocates a module (as 0.85 did with `chat-viewport.js`), the navigator/viewport/scroll features die with only a `process.emitWarning`, while the disk-patch probes can still pass — the app reports "optimizations on" (index.ts:143-155) with a half-working TUI.
3. **High — unversioned private API surface in the main process.** Six-plus services import `SessionManager`, `ModelRuntime`, `SettingsManager`, `DefaultPackageManager`, `loadSkills`, `parseFrontmatter`, `CONFIG_DIR_NAME` from the package (session-service.ts:66-100; model-service.ts:271-592; command-service.ts:249-282; skill-service.ts:42-230). A rename or signature change crashes the Electron main process at first use, not at build time (the package is a runtime `import()`).
4. **Medium — update path is a hard gate with an all-or-nothing fallback.** A new Pi minor has no compatibility profile and blocks the update behind `E_PI_TUI_COMPATIBILITY_REQUIRED` (pi-update-service.ts:388-390, 255-258); accepting stock fallback persists the optimization off (index.ts:202-207), degrading resize/scroll for all sessions until a patch is authored. `package.json:140-157` enumerates each patch file as `extraResources`, so a new patch variant must be registered in three places (patches dir, profile table, package.json) or packaging silently omits it.
5. **Medium — session blast radius.** `reloadAll` unconditionally kills and respawns every live Pi session (pi-runtime.ts:282-291) on auth/model changes and after any Pi update (index.ts:99, 158, 209); a user with N open sessions loses all in-flight agent runs. There is no cap on concurrent PTY sessions (pi-runtime.ts:148-166), each running a full Node CLI process.
6. **Medium — readiness/timeouts are heuristic.** "Ready" depends on a sidecar JSON appearing (pi-runtime.ts:573-617) with a re-armed 30 s timeout; a Pi version that changes the sidecar path or field names leaves sessions stuck in `starting` while input is still forwarded (pi-runtime.ts:293-311).
7. **Medium — global monkey-patches with no teardown.** The bridge replaces `process.stdout.write` (e-pi-bridge.ts:204-228), `ctx.ui.custom` (e-pi-bridge.ts:640-653) and installs empty header/footer + a custom editor (e-pi-bridge.ts:748-755). None are restored; ordering relative to other third-party extensions is unspecified.
8. **Low — protocol constants duplicated across languages.** OS C IDs, ESC-APC markers and wheel patterns are defined independently in `e-pi-tui-hooks.mjs:35-53`, the disk patch (`patches/...pi-tui@0.85.1.patch:637-638`) and `src/lib/terminalViewportProtocol.ts:1-14`; only the mjs side is asserted against the host (test/pi-tui-runtime-hooks.test.ts:26-34).
9. **Low — repeated hardcoded thinking-level lists** in pi-runtime.ts:36-44, e-pi-bridge.ts:169-172 and PiAgentSettings.tsx:22-31; a new Pi level requires three edits plus the validation filters in pi-runtime.ts:655-667.
10. **Low — update installs with the user's npm.** `npmCommand()` honors Pi's own `npmCommand` setting (pi-update-service.ts:120-131) and installs into `app.asar.unpacked` (packaged) or `userData/pi-agent` (dev), leaving a mutable, unsigned package directory inside the app bundle.
