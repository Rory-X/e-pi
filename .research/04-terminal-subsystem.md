# Terminal Subsystem (E-Pi)

## Summary

E-Pi renders Pi's fullscreen TUI in xterm.js: a node-pty in the main process streams bytes over per-session `runtime:data` IPC, an app-lifetime feeder retains a per-session replay buffer, and a mounted terminal either replays it or holds the loading overlay until Pi's next authoritative frame. Because Pi's steady-state output is differential (full frames only on first render/size change — `00ff35c`), the subsystem is mostly _resynchronization_ machinery: 16 `src/lib` helpers implementing a private APC/OSC protocol, a resize gate, a WebGL double-buffer, and three watchdog loops. Sidebar terminals are a second node-pty + xterm pipeline sharing only the resize scheduler and scrollback guard.

## Findings

### Data path: PTY → pixels

- Spawn: `--import resources/e-pi-tui-hooks.mjs` installs the protocol producer (`electron/main/services/pi-runtime.ts:422`); PTY defaults 120x36 (:442-443), `resize()` floors at 20 cols/8 rows (:343).
- Batching: 8 ms or 64 KB; a complete synchronized frame (`CSI ?2026l`) flushes at once (`electron/main/services/output-batcher.ts:30-31,70-80`; "2,165 chunks/s under load", :5).
- IPC: `onGlobalData` → `sendToRenderer("runtime:data")` (`electron/main/index.ts:631`) → preload listener (`electron/preload/index.ts:147-151`).
- Rendering: `OptimizedTerminalPanel` builds xterm + FitAddon + WebglAddon + WebLinksAddon (`src/components/workspace/TerminalPanel.tsx:143-182`); live chunks traverse the resize output gate (:489-500), replay goes through `flushWrite` (:522-526).
- Geometry: `FitAddon.proposeDimensions` is monkey-patched to measure `.xterm`'s content box, not the padded panel border-box (`src/lib/xtermFit.ts:44-46`, rationale :13-21).
- Main-terminal extras: OSC 52 clipboard (1 MB bound, fatal UTF-8 decode — `src/lib/terminalOsc52.ts:9-25`), OSC 6973/6974 viewport + navigator (`src/lib/terminalViewportProtocol.ts:1-2`), and a wheel handler rewriting gestures into `e-pi:viewport:wheel:v1` (`TerminalPanel.tsx:189-216`).
- Side terminals: one node-pty per panel, login shell `-l` on POSIX but bare `powershell.exe` on Windows (`electron/main/services/side-terminal-service.ts:74-105`); a 400 ms `pty.process` poll decides raw-input mode and restores the tty line discipline via `/bin/stty` (:56-72,:116-150; programs in `side-terminal-interactive.ts:12-132`).

### Helper modules (problem / mechanism / assumption)

- **terminalReplayBuffer.ts** — unmount-safe replay. Keeps only the stream from the last authoritative redraw (main `ESC[2J ESC[H ESC[3J`; alt `?2026h 2J 1;1H 2K`, :6-17); segmented storage is lazily joined so appends never copy the buffer (~77 µs/chunk before, :35-46). `DEFAULT_TERMINAL_REPLAY_LIMIT = 8_000_000` chars, sized for a "measured ~4.6 MB frame" (:21-24). Assumes Pi re-emits a full frame only on resize/layout change (:149) and markers never straddle >10 chars (:140).
- **terminalReplayStore.ts** — module-level LRU: 6 buffered sessions, 12 evicted markers (:19,29); an evicted session gets an awaiting-checkpoint placeholder because its process may be live (:48-67); `isAwaitingCheckpoint` drives the remount redraw (:73-80).
- **terminalBufferFeeder.ts** — exactly one renderer-lifetime `onAnyData` subscription, outside both terminal implementations so mode switches cannot double-register (:5-13).
- **terminalResizeProtocol.ts** — APC tag `\x1b_e-pi:frame:<cols>x<rows>\x1b\\` emitted right after the redraw prefix (:7-25); `inspectResizeFrameMetadata` classifies pending/untagged/invalid/tagged from a few bytes (:32-51), assuming it arrives in the first chunk.
- **terminalResizeOutputGate.ts** — 4-phase machine (`idle|resizing|awaiting-checkpoint|streaming-checkpoint`, :35) hiding old-grid output during resize and streaming only a frame tagged with the expected grid (:177-184). Fail-closed: any non-Pi producer yields a permanent wait; old-size hold capped at 400 KB (:37,:167).
- **terminalResizeVisualGuard.ts** — visual double buffering: copies the WebGL/canvas renderer into a hidden canvas at z-index 4 (:56-80,:140-200), swaps front/back on presentation (:195-199), gives up after 4 failed captures (:236-252); assumes non-preserved WebGL buffers are readable only in their producing render task (:305-314).
- **xtermResizeScheduler.ts** — preemptible latest-wins coordinator: local `fit.fit()` per frame, PTY resize only behind a parser permit (:135-143,:195-229), gate armed _before_ SIGWINCH (:225-227). `QUIET_FRAMES = 2`, `MAX_UNMEASURABLE_FRAMES = 60` (:45-46).
- **xtermResizeSchedulerStock.ts** — retained alternate policy: 120 ms drag refit, 1 settle frame, 100 ms barrier cap, `LARGE_WRITE_BYTES = 4096` gating local reflow (:27-31,:92-105,:149-160).
- **xterm.ts** — `smoothScrollDuration: 0`, because xterm v6 bakes a clamped intermediate `scrollTop` into the smooth-scroll keyframe (:25-32).
- **xtermFit.ts** — assumes the private `_core._renderService.dimensions.css.cell` shape (:26-31), returning `undefined` (no fit) if it changes.
- **xtermScrollbackGuard.ts** — suppresses `CSI 3 J` / `CSI ? 3 J` at _parse_ time so a queued chunk cannot race the user's scroll (:12-33); assumes `2J` precedes every repaint.
- **xtermViewportRestore.ts** — restores once after the viewport stops moving (2 stable frames, ≤60 frames ≈1 s, ±5 lines), plus a straggler rAF (:33-35,:60-72).
- **xtermViewportWatchdog.ts** — 1000 ms reconciliation of derived `atBottom`; never moves the viewport (:23-45).
- **terminalViewportProtocol.ts** — OSC 6973/6974 codecs (:1-104), wheel IPC with cell-coordinate mapping (:106-159), per-rAF batcher releasing the first whole row at once (:161-204); clamps ±9999 rows, coords ≤99999 (:6-7).
- **terminalOsc52.ts** — bounds terminal-controlled clipboard writes at 1,000,000 base64 chars before allocating decoded bytes (:9-18).
- **tui-ansi-light.ts** — rewrites Pi's baked `truecolor #ffff00` SGR on the wire and repaints painted cells with `ESC7…ESC8` (:11-19,:47-101); assumes Pi will not recreate those widgets on theme switch (:42-46).
- **terminalTheme.ts** — dark/light ANSI palettes; background read from the rendered surface (:52-57).

### Attach / replay flow

- Reattach never re-reads the transcript journal; the picture is rebuilt from the retained VT stream (`TerminalPanel.tsx:292-298`). Empty replay sets `waitingForFirstFrame`/`waitingForCheckpoint`/`bootstrapCheckpointPending`, so the first PTY resize becomes a checkpoint shimmy (:356-370,:416-427).
- The overlay lifts only after all initial writes commit plus **two rAFs** (:310-319); `onFirstPaint` fires at most once per mount (:299-303).
- Ordering is load-bearing: the data subscription is installed _before_ the replay snapshot so IPC order guarantees the feeder already appended (:485-500); live chunks queue while `replaying` (:489-521).
- Restart is detected by generation, baselined via `getStates()` because `onState` fires only on change; on increase the terminal resets and the grid is re-asserted (`TerminalPanel.tsx:444-483`).
- `test/e-pi-bridge-attach.test.ts` only asserts the `e-pi-attach` message shape (:45-63) — it does **not** test reattach/replay. `MessageNavigator.tsx` is presentation-only: active row = last entry with `offset <= scrollTop+1` (:59-64); click writes `encodePiScrollToRowInput` to the PTY (:87, `TerminalPanel.tsx:577`).

### Recent hard-won fixes

- `dbba4b9` — scroll-to-top cluster (`smoothScrollDuration: 0`, parse-time `3J` suppression, settle restore, watchdog); the committed tree **could not compile**. Bug class: worktree-only fixes.
- `0831990`/`b6d5b88`/`774f724` — replay segmentation (~77 µs/chunk), LRU store, and the eviction fallback that stops an evicted session's terminal from staying blank. Bug class: unbounded renderer buffers.
- `9bf0c46`→`7f83dee`→`a1167db`→`f5e7e38` — four corrections to one heuristic: settle frame 2→1, add a 120 ms drag refit, bail local reflow on any pending write, then narrow that to large (>4 KB) frames because Pi's ~80 ms spinner ticks left a black gap. Bug class: empirically tuned gating.
- `00ff35c`/`0bdd3cf` — overlay lift timing (async `write` ⇒ half-drawn flash; differential steady state ⇒ partial screen). Bug class: async parse/render accounting.
- `1befcdf`/`90c733e`/`bed3be8`/`4cb4c71` — protocol growth (OSC 52, resize tagging, viewport/nav OSC, xterm fit), each needing vendored Pi TUI patches (`patches/@earendil-works__pi-tui@0.84.2|0.85.0|0.85.1.patch`, 776–777 lines each; `pi-coding-agent@0.85.0.patch`, 163 lines). Bug class: renderer protocol coupled to Pi internals.

## Risks

1. **High — timing constants no test can validate.** 2 quiet frames / 60 unmeasurable frames (`xtermResizeScheduler.ts:45-46`), 2 stable frames / 1 s / ±5 lines (`xtermViewportRestore.ts:33-35`), 8 ms+64 KB (`output-batcher.ts:30-31`), 120 ms refit + 100 ms barrier cap (`xtermResizeSchedulerStock.ts:27-30`). High-refresh displays, load, and software rendering shift them silently.
2. **High — renderer memory growth.** 8 M chars per replay buffer × 6 LRU sessions (`terminalReplayBuffer.ts:24`, `terminalReplayStore.ts:19`), 12 evicted markers, and 12 000/8 000 scrollback lines per terminal (`TerminalPanel.tsx:148`, `SideTerminalView.tsx:589`).
3. **High — fail-closed protocol coupling.** The gate accepts only a tag emitted by E-Pi's hooks inside Pi's synchronized frame; if Pi restructures a frame the gate parks in `awaiting-checkpoint` and the terminal stays blank until the shimmy fires (`terminalResizeOutputGate.ts:169-188`, `terminalReplayStore.ts:73-80`). Three patch sets need re-basing per Pi release.
4. **Medium — platform skew.** Foreground detection normalizes a macOS 16-char `p_comm` (`side-terminal-service.ts:56-72`); editor mode is a no-op on Windows (:120) and uses BSD `stty -f`, so on Linux tty echo/icanon never tracks the overlay editor. `SideTerminalView` also never calls `fitToTerminalElement` (unlike `TerminalPanel.tsx:152`), so the fit bug fixed in `4cb4c71` may persist.
5. **Medium — ordering across four queues.** Feeder → panel listener → output gate → xterm FIFO behind a barrier (`terminalBufferFeeder.ts:5-13`, `TerminalPanel.tsx:485-521`, `output-batcher.ts:64-66`); one added await or reordered subscription silently corrupts replay.
6. **Medium — overflow dead ends are user-visible.** Overflow discards the stream until a full redraw (`terminalReplayBuffer.ts:163-167`); a >8 MB frame recovers only via the shimmy, which briefly asserts `rows+1` (`TerminalPanel.tsx:356-370`).
7. **Low — duplication + debug leftovers.** Two duplicate schedulers plus a third inline policy (`SideTerminalView.tsx:624-642`), a stale contradicting comment (`TerminalPanel.tsx:268-276`), `console.log("[side-term del]")` per Backspace (`SideTerminalView.tsx:410-417`), duplicated helpers (`TerminalPanel.tsx:57-109`).
8. **Low — private xterm APIs and side-terminal routing.** Cell metrics come from `_core._renderService.dimensions.css.cell` (`xtermFit.ts:27`, `SideTerminalView.tsx:168-176`), so an xterm bump silently disables fit or the overlay caret (both have partial fallbacks); `SideTerminalService` holds one `#listener` (`side-terminal-service.ts:50-54`).

## Not found

- No test covers the end-to-end attach/replay path (`test/e-pi-bridge-attach.test.ts` only shapes the `e-pi-attach` message), and no Linux/Windows-specific tests exist for the side-terminal services beyond the program-name predicate.
