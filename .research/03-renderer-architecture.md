# E-Pi Renderer Architecture

## Summary

The renderer is a single-screen Electron shell with no router: `src/App.tsx` (804 LOC, 18 `useState` atoms plus 13 more inside two hooks) is the composition root, wiring a left session sidebar, a terminal workspace, a right tabbed tool panel and overlay drawers. There is no global store — state lives in three places: App-local `useState`, domain hooks (`useSessionRuntime`, `useWorkspaceOverlays`), and seven module-level pub/sub registries in `src/lib/` (three of them the "buses" named in the brief). Tailwind 4 serves only the shadcn primitives; ~6,800 lines of hand-written global CSS carry the rest, with per-module font scales built on CSS custom properties. The largest components (`WorkspaceCodeEditorOverlay` 1231 LOC, `Composer` 844) fuse component state, protocol encoding and CodeMirror/xterm lifecycles. All 45 test files are `.test.ts` — no `.tsx` test exists, so component-level coverage is zero.

## Findings

### Entry and composition

- `src/main.tsx:16-18` applies theme and per-module font sizes before React mounts to avoid a flash; `main.tsx:20-27` mounts `App` inside `StrictMode` + `TooltipProvider` + `Toaster`. No router, no providers for state, no error boundary.
- CSS enters through two paths: `main.tsx:4-7` (xterm + `app.css`/`git.css`/`workspace-files.css`) while `styles/app.css:4-12` imports the other nine sheets — two files sit outside the Tailwind import graph.
- Panel/overlay model is three independent state machines: modal drawers (`packageOpen`/`skillOpen`/`settingsOpen`, `App.tsx:48,49,60`), the tool-panel tab list `{tabs, activeId}` with review as a forced singleton (`App.tsx:85,405-419`), and the workspace overlay machine in `useWorkspaceOverlays.ts:96-196`.
- App owns 18 `useState` (65 hook calls total); session/project plumbing (create, rename, archive, promote, reload) sits inline (`App.tsx:155-403`) rather than in a hook.

### Component inventory

- `workspace/`: `SessionSidebar` orchestrating `sidebar/{ProjectRow,SessionRow,ProjectFlyout,activity}`; `Composer` (+ children); `TerminalPanel` (dispatcher at `TerminalPanel.tsx:597-600` picks optimized vs `StockTerminalPanel`); `SideTerminalView`; `FileTreeView`; `ToolPanel` (tab host for `ReviewView`/`FileTreeView`/`SideTerminalView`); `WorkspaceOverlayHost` mounting the editor/preview/markdown/mermaid overlays.
- `panels/`: `PackagePanel` (198) → `PackagePanes` (434), `ReviewView` (504, git UI), `DiffView` (96).
- `settings/`: `AppDialogs` (260) is both the rename/archive/remove dialog host _and_ a six-tab Settings screen (`AppDialogs.tsx:197-260`); `ModelSettings`/`ModelProviderList`/`ModelProviderDetail`/`CustomProviderDialogs` (552) form the model cluster; `PiAgentSettings` (428) plus five ~100-LOC panes.
- `ui/`: 22 vendored shadcn/Radix files; `sidebar.tsx` (422) is locally modified (`:59-63,148`, localStorage width).
- God-components (see table): `WorkspaceCodeEditorOverlay`, `Composer`, `SideTerminalView`, `FileTreeView`, `SessionSidebar`.

### State management

- No global store: `package.json:28-90` lists no zustand/redux/jotai. `useSessionRuntime.ts:17-121` is the closest thing — it owns `appInfo/sessions/activePath/runtimeStates/loading/error`, subscribes `runtime:state` (`:82`) and `sessions:onUpdated` (`:96`), and bails out on equal states via `isSameRuntimeState` (`:90`) so memoized children keep identity.
- Seven module-level registries with two incompatible patterns: fire-and-forget callback sets (`composerBus.ts:17-37`, `attachmentsBus.ts:10-23`, `modelsCatalogBus.ts:7-20`) and snapshot stores intended for `useSyncExternalStore` (`quickCommands.ts:84-100` + `useQuickCommands.ts:10`, `modelVisibility.ts:105-191` + `useModelVisibility.ts:15`, `editorSettings.ts:36`, `appearance.ts:59-78`).
- Subscription lifecycle is correct today: every bus subscriber returns the unsubscribe inside `useEffect` (`Composer.tsx:258,315,320-329`, `WorkspaceCodeEditorOverlay.tsx:776`, `FileTreeView.tsx:409`), and `composer-bus.test.ts:8-30` covers add/remove/fan-out.
- Concrete bus pitfalls as used here:
  1. `composerBus` is a single module-level `Set` with no delivery guarantee: `emitInsertComposerReference` returns `false` and silently drops the reference when no composer is mounted (`composerBus.ts:32-37`); the editor path only toasts when handled (`WorkspaceCodeEditorOverlay.tsx:776`), but `SessionSidebar.tsx:131-133` and `FileTreeView.tsx:409` emit attachments and toast optimistically with no ack (`attachmentsBus.emitAttachFiles` returns `void`, `attachmentsBus.ts:21-23`).
  2. No replay buffer — unlike `useWorkspaceOverlays`, which mirrors open requests to sessionStorage (`useWorkspaceOverlays.ts:152-177`), a reference emitted before the composer mounts is lost forever.
  3. `modelsCatalogBus` is pure invalidation: it does not carry the new catalog, so every subscriber re-issues an IPC call (`Composer.tsx:250-259`) each time Settings saves (`ModelSettings.tsx:150,227,243` emit three separate times for save/remove/logout).
  4. Buses are process-global: nothing in the types says which composer receives an emit.
- Duplicated stateful derivation: `useUnseenRunCompletions` is instantiated twice, in `App.tsx:43` (dock badge) and `SessionSidebar.tsx:127` (row dots), i.e. two independent copies of the same ref-based transition tracker.

### Hooks

- `useSessionRuntime.ts:60-107` inits via `Promise.all` + `runtime.start` of the first session; `refreshSessions` (`:27-37`) silently re-points `activePath` to `next[0]` when the active session vanishes.
- `useComposerCommands.ts`: 8 `useState`, parses `/cmd` and `/cmd arg` from the caret line (`:50-68`), merges skills as `skill:<name>` (`:78-85`), ranks prefix/substring/description (`:91-100`), and loads argument completions once per command with a ref guard (`:150-176`).
- `useGlobalShortcuts.ts:48-72`: single window keydown; Escape handling is order-dependent and lacks an `isComposing`/IME guard, so Escape during pinyin composition can close a drawer; no `defaultPrevented` check either.
- `useWorkspaceOverlays.ts`: well-documented mounted/open/openRequest/closeRequestId machine with monotonic ids, mutual exclusion (`:109-125`) and dev reload restore (`:199-217`); the only weakness is that `App.tsx:502-505` force-closes overlays on every `activeCwd` change behind an `eslint-disable`.
- `useUnseenRunCompletions.ts:30-60`: pure transition detector over `runtimeStates`; state is intentionally retained rather than derived.

### Styling

- Tailwind 4 is wired through `@tailwindcss/vite` (`electron.vite.config.ts:33`) with a class-based dark variant (`app.css:15`), but real usage is thin: only `base.css:3,7` use `@apply`; the shadcn primitives use utilities, everything else uses bespoke global class names. The result is a hybrid: ~6,800 CSS lines with ~850 top-level selectors (`git.css` 173, `models.css` 193, `sidebar.css` 162, `workspace.css` 140, `workspace-files.css` 115) and no scoping/isolation mechanism.
- Light/dark sync: single source of truth is the `dark` class on `<html>` (`theme.ts:27`), driven by stored choice with live OS fallback (`theme.ts:50-55`); `useIsDark.ts:7-16` reads it via MutationObserver; main process is told pre-mount (`theme.ts:34`). Only `theme.css:92` defines a global `.dark` block; `workspace.css` adds 3 local `.dark` rules, and `workspace-files.css` contains 14 raw hex colors with no dark block at all — the likeliest light-mode regressions.
- Per-module font sizing is the cleverest and most fragile part: `theme.css:63-89` defines `--fs-scale-{sidebar,workspace,models,packages,git,skills}` plus a role ladder, and `theme.css:205-253` must _redeclare the whole ladder_ on every scope selector because `var()` in a custom property resolves at the declaring element. `appearance.ts:93-105` writes the six knobs as inline styles on `<html>`. Adding a module means editing two synchronized selector lists (`theme.css:210-233` and `:235-253`).
- Responsiveness is desktop-window oriented (`responsive.css:1-49`); reduced-motion is honored (`:51-59`).

### Biggest components

| Component                         | LOC  | Evidence                                                      |
| --------------------------------- | ---- | ------------------------------------------------------------- |
| `WorkspaceCodeEditorOverlay.tsx`  | 1231 | `src/components/workspace/WorkspaceCodeEditorOverlay.tsx:419` |
| `Composer.tsx`                    | 844  | `src/components/workspace/Composer.tsx:117`                   |
| `SideTerminalView.tsx`            | 726  | `src/components/workspace/SideTerminalView.tsx:88`            |
| `WorkspaceFilePreviewOverlay.tsx` | 701  | `WorkspaceFilePreviewOverlay.tsx:34`                          |
| `FileTreeView.tsx`                | 695  | `src/components/workspace/FileTreeView.tsx:66`                |
| `SessionSidebar.tsx`              | 690  | `src/components/workspace/SessionSidebar.tsx:90`              |
| `TerminalPanel.tsx`               | 600  | `src/components/workspace/TerminalPanel.tsx:111`              |
| `CustomProviderDialogs.tsx`       | 552  | `src/components/settings/CustomProviderDialogs.tsx:159`       |
| `ReviewView.tsx`                  | 504  | `src/components/panels/ReviewView.tsx:177`                    |

- `WorkspaceCodeEditorOverlay` is the worst: 15 `useEffect`s, CodeMirror state, tab lifecycle, dirty-save dialogs, context menu and theme rebuilds (`:467-959`) in one component — changes risk the save/close invariants and there are no render tests.
- `Composer` embeds the wire protocol: it hand-builds messages with magic strings `/skill:<name>` and `/e-pi-attach <base64>` (`Composer.tsx:356-378`) and writes agent config on a thinking-level change (`:430-441`). Renderer and pi TUI command surface are coupled through string concatenation, not types.
- `SessionSidebar` renders all visible rows (`SessionSidebar.tsx:424`) with a 5-row preview but no virtualization, and takes 20 props (`:60-88`), so every session/runtime state update re-renders the whole sidebar tree unless all props stay identity-stable.
- Helper duplication is already visible: `basename` and `formatBytes` are re-implemented in `WorkspaceCodeEditorOverlay.tsx:111-123` and `WorkspaceFilePreviewOverlay.tsx:34-40` while `format.ts:78` exports `formatBytes`; and three disagreeing image-extension lists exist (`Composer.tsx:110-111`, `FileTreeView.tsx:58`, `workspacePreviewKind.ts:8` — the last adds avif/svg/ico).

## Risks

1. **High — App is the de-facto store and must hand-maintain memo discipline.** App re-renders on every `runtime:state` event, so UI correctness depends on stable callbacks/refs (`App.tsx:594-613`, `WorkspaceOverlayHost.tsx:29-44`); one inline arrow reintroduces re-render storms, with no test to catch it.
2. **High — the bus pattern silently drops events.** `emitInsertComposerReference` can return `false` with no retry (`composerBus.ts:32-37`), and `emitAttachFiles` gives no feedback at all (`attachmentsBus.ts:21-23`) while callers toast success optimistically (`SessionSidebar.tsx:132`, `FileTreeView.tsx:409`). Users see "Added to chat" for an attachment that never arrived.
3. **High — god-components with coupled lifecycles.** `WorkspaceCodeEditorOverlay` (1231 LOC, 15 effects) and `Composer` (844 LOC, 15 `useState`, xterm/IME/command-popup/attachments) concentrate unrelated concerns; the repo has 45 `.test.ts` files and zero `.tsx` tests, so refactoring them has no safety net.
4. **Medium — duplicated stateful derivations drift.** `useUnseenRunCompletions` runs twice (`App.tsx:43`, `SessionSidebar.tsx:127`) and App and SessionSidebar each call `window.ePi.app.setDockBadge`-adjacent logic independently; small logic edits must be made in two call sites to stay consistent.
5. **Medium — CSS is accreted, not layered.** Two styling systems (utilities in `ui/*` vs ~850 global selectors), per-module font ladders that must be manually redeclared (`theme.css:205-253`), and `workspace-files.css` with 14 hard-coded hex colors and no dark block make theme and font changes error-prone.
6. **Medium — renderer-to-agent coupling via magic strings.** `/e-pi-attach` base64 payloads and `/skill:` prefixes built in `Composer.tsx:356-378` are an undocumented wire format; a pi-side rename breaks the composer silently at runtime.
7. **Low — no error boundary.** `main.tsx:21` enables `StrictMode` (double-invoked effects in dev) but nothing catches a throwing overlay, which would blank the window; `App.tsx:288-294` re-subscribes `onOpenSession` every render (no dep array).
