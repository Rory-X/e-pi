# E-Pi Domain Services — Research Report

Domain logic lives almost entirely in main-process services behind one flat IPC surface (`electron/main/index.ts`,
mirrored by the `window.ePi` bridge in `electron/preload/index.ts:69-271`); the renderer is thin orchestration plus
localStorage stores main cannot see. `file-service` (path confinement + optimistic writes) and
`project-service` are the cleanest abstractions; git numstat parsing (a verified bug) and `skills:read` (no
confinement) are the worst, and the model layer re-creates a `ModelRuntime` per IPC call. Coupling to upstream
`@earendil-works/pi-coding-agent` (via `pi-agent-loader.ts`) is heavy and silently assumed everywhere.

## Findings

**1. Git code review**

- `GitService` shells out via `execFile("git", args)` (60 s, `git-service.ts:90-106`; push/pull 120 s); `status()` runs
  five sequential git calls plus per-file disk reads (`:296-331`).
- **numstat bug (reproduced).** Stats come from one `git diff --numstat -z HEAD` (`:158`). For renames git emits
  `0\t0\t\0old\0new\0` — an empty path. The parser needs `/^(\d+)\t(\d+)\t(.*)$/s` (`:163`), so that record is skipped
  and the guard at `:170` consumes the old-path field, dropping its deletions. Reproduced byte-exactly:
  `[b'0\t0\t', b'old.txt', b'new.txt', b'']`. Renamed files show +0/−0 and the `ReviewView.tsx:195-205` total
  undercounts.
- `git diff HEAD` conflates staged+unstaged (`:198-221`), so per-file diffs never show the index snapshot.
- `diff()` re-runs full `status()` for one entry (`:333-338`) — O(repo) per expanded file; untracked line counts read
  whole files (`:154-196`).
- `commit()` uses a temp message file with `-F` (`:357-374`); `push()` silently targets `origin` and sets upstream when
  missing (`:376-389`); `pull()` is bare (`:391-398`).
- AI commit messages (`:401-471`): `--cached`/`HEAD` diff + bounded untracked excerpts (200 lines, `:56,:415`), 48 KB
  truncation (`:429-431`), then a **new** `ModelRuntime` + `SettingsManager` (`:433-438`) and `complete()` with a 120 s
  abort. Prompt `:58-68`; `cleanMessage` caps 8 000 chars (`:70-88`). Failures surface as raw IPC text
  (`useGitReview.ts:171-173`).
- IPC `git:*` at `index.ts:427-456`, each coalescing `cwd || activeCwd()`; debug logging skips diff/stage/unstage.
- `useGitReview.ts` has four refresh paths: cwd (`:53-61`), runtime busy→idle throttled to 2 s (`:67-79`),
  `git:changed` (`:81-91`), post-operation (`:139,148,188,235`). Diff loads use an in-flight `Set` + `cwdRef`, not
  cancellation (`:26,93-117`).
- **Implicit stage-all:** `commit()` auto-generates the message and `git add -A`s the whole tree when nothing is
  staged (`useGitReview.ts:206-217`).
- Repo watching is single-repo (`git-service.ts:224-256`) with a 1.5 s self-trigger guard (`:275`) and 600 ms/2 s
  debounce (`:280-287`) — external `git add` inside that window is dropped. `classifyWatchEvent`
  (`:29-43`) is tested (`test/git-service.test.ts:149-171`), as are rename/stage/commit/push (`:40-147`); numstat is not.
- `workspace-watcher-service.ts` is the multi-root watcher (per-cwd `Map` `:34,47-61`, non-recursive fallback
  `:140-171`, 300 ms merge) feeding `FileTreeView.tsx:256-269`.
- `DiffView.tsx` renders `@pierre/diffs` `PatchDiff` with `disableWorkerPool` (`:91`), styled via `unsafeCSS` over
  pierre's `--diffs-*` vars (`:17-42`). Truncation rides a **sentinel string inside the patch**, stripped by regex
  (`:87-88`), so real content matching it is mangled. No virtualization. `diffPreload.ts:13-75` warms 43 Shiki langs.

**2. Packages**

- `PackageService` wraps pi's `DefaultPackageManager`, rebuilding the manager per call (`package-service.ts:232-242`).
- **Installs are always global** — `installAndPersist(source, { local: false })` (`:184`) — despite a per-workspace
  drawer; `remove` tries both scopes (`:192-201`). `normalizePackageSource` (`:50-62`) prefixes `npm:` onto any
  scheme-less non-path spec.
- Search/downloads use Electron `net.fetch` (`:116-176`); the "latest version" probe shells out to `npm view` via pi's
  `getNpmCommand()` (`:210-230`). Caches: 5 min updates `:24`, 10 min search/downloads `:30,32`.
- **No Node/npm on PATH:** `ensureNpmOnPath()` runs once at startup (`index.ts:717`) and mutates `process.env.PATH`
  (`npm-path.ts:17-26`): bundled sidecar (packaged only, `:34-39`), then PATH dirs, then hard-coded
  nvm/fnm/volta/asdf/Homebrew locations, preferring dirs holding `node` too (`:41-105`). If nothing resolves, installs
  fail with pi's raw `spawn npm ENOENT`; a Node installed after startup is never found.
- `scripts/fetch-node.mjs` pins `v22.23.2` (`:33`), copies `bin/node` + the npm CLI and writes launcher shims
  (`:115-130`); the folder is generated/git-ignored (`:103-113`) and shipped via `extraResources`.
- All mutations funnel through one `run()` setting `needsReload` (`PackagePanel.tsx:58-74`); the user must press
  "Reload Pi" (`:186-194`).

**3. Skills**

- `list()` delegates to pi's `loadSkills` plus `~/.agents/skills` and ancestor `.agents/skills` up to the git root
  (`skill-service.ts:41-64,67-79`), filters root-level files there (`:60`), and classifies user/project/path by
  **location**, not pi's `sourceInfo` (`:198-204`) — an explicit workaround.
- Enable/disable rewrites SKILL.md frontmatter `disable-model-invocation`, re-serializing the block with
  `yaml.stringify` (`:141-156`).
- `remove()` trashes the owning directory/file and prunes the path from global and project settings
  (`:158-183`) — a path-scoped skill is deleted outside the repo; the UI warns (`SkillPanel.tsx:301-317`).
- `read()` resolves any absolute path with **no confinement** (`:81-85`), exposed as `skills:read`
  (`index.ts:421`), unlike `FileService.isInside`; unused by today's UI (`SkillPanel.tsx:71` calls only `list`).
- Mutations return the whole list (`SkillPanel.tsx:97-111`) and apply only after "Reload Pi" (`:242-250`); tests cover
  create/validation/discovery (`test/skill-service.test.ts:41-90`).

**4. Models and providers**

- `ModelService` builds a **new `ModelRuntime` per call** (`model-service.ts:548-551`) for list/login/logout/
  setDefault/unique-id. Login is single-flight (`:321-322`), bridging pi's prompt to the renderer (`:340-373`), answered
  via `models:login-response` (`:409-415`); main opens auth URLs/device codes (`index.ts:507-513`). Every credential
  change restarts the live runtime (`index.ts:506,514,529,534`).
- `setDefault` writes the **global** settings default (`:427-437`) and additionally injects
  `/model provider/id` into the live session (`index.ts:524-533`) — so the composer's per-session picker mutates a
  global default.
- Custom providers live in `<agent>/models.json`: read via a hand-rolled comment stripper (`:78-116`), written wholesale
  with no locking (`:293-298`), unknown keys preserved by merging (`:468-511`). Official metadata is hunted across four
  hard-coded pi-ai paths (`:149-197`); `fetchModels` probes `/models` then `/v1/models` (`:609-655`); `catalogMeta`
  fetches models.dev (`:670-702,740-778`).
- Visibility is a **renderer-only localStorage store** (`src/lib/modelVisibility.ts:27-201`) shared via
  `useSyncExternalStore`; login marks a provider default-hidden (`ModelSettings.tsx:158`), custom save reveals chosen
  models (`:196`), then `emitModelsCatalogChanged()` reloads the composer (`Composer.tsx:255-262`). Per-session
  selection is optimistic with a 5 s timeout (`Composer.tsx:137,220,264-269,419`).

**5. Files, projects, sessions**

- `FileService` is the only confined service (`file-service.ts:46-49,67-74`); caps 512 KB/1 MB/32 MB (`:19-23`);
  atomic temp+rename writes (`:267-275`) with `contentHash`/`mtimeMs` checks (`:254-265`); error codes ride inside
  `Error.message` as `[E-PI-FS:CODE]`, since IPC preserves only messages (`:30-44`).
- `mentionSearch` walks the tree per debounced query, no index, cap 200 (`:130-148,316-342`), once per repo root
  (`FileTreeView.tsx:271-303`) — cost scales with repo size, not matches.
- `ProjectService` is a label/routing layer over folders, persisted atomically via a write chain
  (`project-service.ts:106-118`); `gitRepos` only checks for `.git` (`:44-46`).
- `SessionService.archive` derives the archive dir by three `dirname` levels (`session-service.ts:117`) and keeps a
  userData index (`:173-175`); archived files are parsed by a hand-rolled pi-JSONL reader duplicating pi's
  `buildSessionInfo` (`:228-286`), and delete uses `shell.trashItem` (`:169`).
- Overlays: `useWorkspaceOverlays` is a mutual-exclusion machine mirrored to sessionStorage for dev-reload restore;
  consumers `WorkspaceCodeEditorOverlay.tsx:516,561,598` / `WorkspaceFilePreviewOverlay.tsx:264`, routed by
  `workspacePreviewKind.ts`.
- Reference/attachment serialization is pure and tested: `[file.ts:10-20](src/file.ts#L10-L20)`
  (`mentionReferences.ts:86-144`), 500-char paste→chip (`textAttachments.ts:9-59`), assembled in `Composer.tsx:350-351`.

**6. Notifications, quick commands, archive, open-with, debug log**

- `TaskNotificationService` fires on busy→idle and entering a wait state for non-focused sessions
  (`notification-service.ts:56-85`); the title lookup calls `SessionManager.listAll()` **per notification** (`:95-97`).
  Instances are retained against GC (`:45,112-122`); macOS `UNErrorDomain` opens a one-shot settings dialog
  (`index.ts:663-686`).
- The sidebar's unseen-completion dot re-derives the same busy→idle edge in the renderer
  (`useUnseenRunCompletions.ts:38-52`) — the same logic duplicated across processes.
- Quick commands: localStorage, capped at 5 entries/10 chars (`quickCommands.ts:22-48`), shown only on an empty
  composer (`Composer.tsx:175`).
- Open-with ranking is a pure heuristic table (`open-with-rank.ts:26-162,242-305`), unit-tested.
- `debug-log.ts` appends to `~/.e-pi-debug.log` only under `E_PI_DEBUG=1` (`:8-33`), truncated at startup (`:16-23`);
  call sites are ad hoc (`index.ts:293-295,428-455`).

## Risks

1. **High — renamed-file stats are wrong.** The `-z` rename record is skipped and its deletions dropped
   (`git-service.ts:158-172`, reproduced); no test covers numstat.
2. **High — `skills:read` is an unconfined arbitrary-file read** (`skill-service.ts:81-85`), exposed at
   `index.ts:421` and only accidentally unexercised.
3. **High — implicit stage-all before commit** sweeps untracked files into the index without explicit user action
   (`useGitReview.ts:206-217`).
4. **Medium — runtime re-creation per IPC call** (`model-service.ts:548-551`; a runtime per commit at
   `git-service.ts:433-438`) repeats credential/catalog work.
5. **Medium — per-session model choice mutates the global default** and restarts the runtime (`index.ts:524-533`,
   `model-service.ts:427-437`).
6. **Medium — package installs are global while the drawer claims workspace scope** (`package-service.ts:184`).
7. **Medium — git refresh is time-heuristic and single-repo**: the 1.5 s guard (`git-service.ts:275`) and one watched
   repo (`:224-256`) can miss external git operations.
8. **Medium — `git pull` is unattended** (`git-service.ts:391-398`): a conflict leaves the repo mid-merge with only
   a toast, and `ReviewView` has no conflict affordance.
9. **Low — settings live in the wrong process**: model visibility, quick commands and diff style are localStorage-only
   (`modelVisibility.ts:27`, `quickCommands.ts:24`, `ReviewView.tsx:45`).
10. **Low — sentinel-string truncation protocol** alters real content matching `[diff truncated]`
    (`DiffView.tsx:87-88`).
11. **Low — duplicated completion logic** in main (`notification-service.ts:62-69`) and renderer
    (`useUnseenRunCompletions.ts:38-52`) can drift, so badges and banners disagree.
12. **Low — no debug-log hygiene**: unbounded synchronous appends, no rotation, uneven IPC coverage
    (`debug-log.ts:25-33`).
13. **Low — upstream formats re-implemented by hand**: pi session JSONL, JSON comments, wholesale models.json rewrites
    (`session-service.ts:228-286`, `model-service.ts:78-116,293-298`) — silent-breakage surfaces.
