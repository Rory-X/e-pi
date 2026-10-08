# Docs, History, Intent — E-Pi

E-Pi is a personal, MIT-licensed Electron shell around the Pi Coding Agent CLI, publicly hosted by `JustGenius-s` but written almost entirely by two Tencent engineers (`morisi@tencent.com` 109 commits, `jiahaoqian@tencent.com` 79). It is **not** a fork of an upstream GUI: the only upstream is the `@earendil-works/pi-coding-agent` npm package, pinned at `0.84.2` and patched with hand-written unified diffs against `dist/` (package.json:46, patches/). The repo carries a real product surface (README.md:15-29, 45) at version 0.1.0, but no CI, no tags, no release automation, and ~2 MB of the authors' own agent scratch data at `.pi-subagents/`. Most docs are Chinese implementation plans describing work that has since largely landed — the best available intent record, and the most likely to rot.

## Findings

### Documentation

- README.md (184 lines) is the only user-facing doc: features (15-29), stack (33-41), install (43-76), build (77-96), commands (98-111), shortcuts (113-122), architecture (148-154).
- README drift only: documents `pnpm` commands (100-111) while package.json scripts call `npm run` (17,19,21), and never mentions the `patches/` + `pnpm-workspace.yaml` compatibility layer (package.json:139-158). Claims I spot-checked are accurate (`e-pi-bridge.ts:692,702`, `sidebar/activity.tsx:5-14`).
- `docs/` = 1233 lines, 903 of them plans: `plan-file-browsing.md` (358), `plan-terminal-performance.md` (545), `research-pi-computer-browser-use.md` (260). README links **none** of them (no `docs/` match in README) — author-facing only.
- `plan-file-browsing.md` is a Chinese LiveAgent-parity spec (1-17, phases 296-329) that was largely executed: `useWorkspaceOverlays.ts`, `workspacePreviewKind.ts`, `mentionReferences.ts`, `composerBus.ts`, `WorkspaceCodeEditorOverlay.tsx`, `WorkspaceFilePreviewOverlay.tsx`, `WorkspaceOverlayHost.tsx`, `workspace-watcher-service.ts` all exist and all appear in its §12 list (354-358).
- `plan-terminal-performance.md` is the strongest doc in the repo: handoff spec with baseline assumptions (4-6), measured evidence (67-74: 76.9 µs/chunk steady state), per-call-site change table (131-140), verification block (43-51). Task A1 shipped — `src/lib/terminalReplayBuffer.ts:36-54,194-197` now uses `segments[]` + lazy `joined`, and `test/terminal-replay-buffer.perf.test.ts` exists.
- `research-pi-computer-browser-use.md` (2026-08-13) is external research, not intent: conclude E-Pi should **not** build computer/browser use, only install community Pi packages. Cites Pi 0.84.0 while the repo pins 0.84.2 — minor staleness.
- `markdown-html-sample.md` / `mermaid-demo.md` are scratch fixtures; the first says "Delete after verifying" (line 3). Neither referenced anywhere.
- Absent: no CHANGELOG, CONTRIBUTING, SECURITY.md, AGENTS.md, or CODE_OF_CONDUCT.

### cursor-review-report.md (untracked, 77 lines)

Produced by an external Cursor agent against an in-flight working tree, not HEAD. Current status of each finding:

- **P0 #1 (temp-file traversal delete, claimed index.ts:270-274): FIXED.** `electron/main/index.ts:273-282` resolves the path, computes `relative(tempDir, resolved)`, rejects `..` outside temp **and** requires `basename(resolved).startsWith("mermaid-")`. The quoted `startsWith` assertion no longer matches code.
- **P1 #3 (Windows backslash prefix mismatch): FIXED** — same path; no hand-written `/` prefix match remains.
- **P1 #2 (multi-repo sibling open used wrong cwd): FIXED.** `src/App.tsx:437-461` adds `folderContainingPath()` and passes that folder as `cwd`.
- **P2 #4 (only activeCwd watched): STILL PRESENT.** `src/App.tsx:492-500` calls `workspace.watchStart(activeCwd)` only (no per-root stop/start); `FileTreeView.tsx:257-259` still carries the false comment "each repo watches its own cwd".
- **P2 #5 (roots from gitRepos, not project folders): STILL PRESENT.** `ToolPanel.tsx:220` passes `roots={repos}`; `App.tsx:117-132` fills `repos` from `projects.gitRepos(folders)` (git only), and `FileTreeView.tsx:69-72` falls back to `[cwd]` only when `roots` is empty — a non-git folder yields an empty tree.
- **P3 #6 (unused `findNode` import, `test/file-tree.test.ts:6`): FIXED** — it imports `findNodeIn` (used 70,71,75,87) and `displayHitPath` (used 104-114).
- Net: both high-severity items are dead; both multi-repo UX gaps are live and independently corroborated by the code.

### `.pi-subagents/`

- 17 files: 2.0 MB `artifacts/` + 24 KB `missions/`; **zero** tracked (`git ls-files .pi-subagents` = 0) and `.gitignore:14-15` ignores it as "# Subagent scratch artifacts".
- Contents are the authors' own pi-subagent runs: 4 mission JSONs with goals like diagnosing repeated "Working..." TUI lines (`missions/fe5a56e2-…json`, status `completed`), plus `*_transcript.jsonl` / `*_input.md` / `*_output.md`.
- Verdict: a checked-_out_, not checked-_in_, artifact of the project's own agent workflow. It does not belong in the repository and does not reach it; keep it ignored, and ignore `.pnpm-store/` (also untracked, present) too.

### Git history and provenance

- `origin` = `github.com/Rory-X/e-pi.git`; `rory` and `upstream` both = `github.com/JustGenius-s/e-pi.git` — one URL under two remote names, so `upstream` is the public repo, not a parent project.
- 206 commits, 2026-08-04 → 2026-08-21, ~51 branches, **0 tags** (no release is cut from git).
- Authors over all refs: morisi 109, jiahaoqian 79, JustGenius-s 15, Rory 8. All 15 JustGenius-s commits are "Merge pull request #N from Rory-X/…" merge commits, and the 8 Rory commits are those same merges — the JustGenius/Rory identities are merge plumbing, not independent contributors.
- Plain answer: **this is a personal project** by two people (Tencent emails, no org, no CI, no tags, MIT © JustGenius), published publicly as if it were a product. `master` (b438f6b) is the MR trunk and is 13 commits behind local HEAD.

### Relationship to upstream Pi

- E-Pi is a **TUI host**, not a reimplementation: one real Pi process per session (`electron/main/services/pi-runtime.ts:415`, `resolvePiEntry()` at :51); `resources/e-pi-bridge.ts` (902 lines) is a Pi extension that suppresses the in-app TUI, adds the custom commands, and emits telemetry.
- Adds over the CLI/TUI: multi-session supervision, git review panel, package/skill panels, model/provider UI, xterm.js terminal with OSC 52 clipboard + viewport/resize protocol, file tree with CodeMirror editor, image/file attachments.
- Maintenance exposure is the headline risk: the pin is exact (package.json:46,57) **and** locally patched — `patches/@earendil-works__pi-tui@0.84.2.patch` has 18 hunks against `dist/components/scroll-view.js`, `layout.js`, `tui-alt-screen.js`. Upstream already ships 0.85.1, and 0.85.0/0.85.1 patch variants exist locally but untracked. `pi-compatibility-service.ts` (406 lines) encodes per-minor probe lists (:23-33) precisely because upstream moved fullscreen layout into `chat-viewport.js` in 0.85; `pi-update-service.ts` (294 lines) swaps Pi **in place** at runtime (:157-289) while re-validating patches. The patch layer is a string-matching dependency on upstream `dist`, re-verified every release.

### Maturity

- version `0.1.0` (package.json:3); artifacts `dist/E-Pi-0.1.0-arm64.dmg`/`-mac.zip`.
- LICENSE MIT, "Copyright (c) 2026 JustGenius" (21 lines); `author: "JustGenius"` (package.json:7); appId `works.earendil.e-pi` (package.json:97) — a third identity belonging to upstream's org.
- Download instructions are real (README.md:45-76), including the Gatekeeper caveat: unsigned, `xattr -cr /Applications/E-Pi.app`, avoid `spctl --master-disable` (55-69); code agrees, `"identity": null` (package.json:167).
- `out/` and `dist/` are **not tracked** (0 in `git ls-files out dist`; `.gitignore:2-3`); `dist/` on disk is ~785 MB.
- No CI: no `.github/`; README recommends CI (:180) but none exists, so releases are manual. Gates that do exist: Husky pre-commit (`lint-staged` + `npm run typecheck`), 45 vitest files, oxlint/oxfmt.

### Strategic assessment

**Top 5 risks to continuing**

1. **High — upstream patch treadmill.** Each Pi release (0.84→0.85.1 within weeks) needs patch regeneration against `dist/` internals plus probe re-validation (`pi-compatibility-service.ts:23-33,50-64`). Failure is silent: fallback to stock pi-tui (`pi-update-service.ts:261-264`).
2. **High — bus factor / non-reproducible releases.** 100% of substantive code from two Tencent emails, no CI, no tags, no CONTRIBUTING; `master` on the public repo is stale.
3. **Medium — release/trust friction.** Unsigned macOS builds (package.json:167) with a per-download `xattr -cr` step (README.md:57-67) is a heavy adoption tax.
4. **Medium — docs that point the wrong way.** `plan-*.md` describe mostly-shipped work in Chinese with no status header; README links none of `docs/`; six stale/unreferenced docs including a "delete after verifying" fixture.
5. **Medium — multi-repo half-built and mis-documented.** Both live cursor-review findings (#4, #5) plus the stale comment at `FileTreeView.tsx:258-259` asserting behavior the code lacks.

**Top 3 aspects worth preserving**

1. **Engineering evidence discipline.** `plan-terminal-performance.md` (67-74 measurements, 131-140 call-site table, 43-51 verification) and the compatibility-service comment blocks are unusually honest. Keeping that style, plus a status line per plan, is the best asset after the code.
2. **Thin-shell architecture.** One Pi process per session, all bridge behavior in one extension file, typed IPC contract in `src/types/contracts.ts`, 45 test files with husky typecheck — this is what makes upstream bumps tractable.
3. **README accuracy and honest restraint.** Features/install/Gatekeeper text match the code, and the browser-use research correctly concludes "install a package, do not build a driver".

## Risks

1. **High — patch/compat layer fails silently on upstream release.** Exact pin (package.json:46,57), 18-hunk dist patches, per-minor probes (`pi-compatibility-service.ts:23-33`), graceful degradation to stock pi-tui (`pi-update-service.ts:261-264`). A broken patch is not a build error.
2. **High — no reproducibility.** Two authors, no CI, no tags, no CHANGELOG; `dist/` built locally. A third party cannot rebuild a released artifact from a tag.
3. **Medium — public repo contradicts local state.** `origin/master` (b438f6b) is 13 behind; `patches/…@0.85.0.patch`, `@0.85.1.patch`, `pnpm-workspace.yaml`, `resources/e-pi-tui-hooks.mjs`, `resources/e-pi-tui-preload.mjs`, `scripts/after-pack.mjs` are all untracked — the 0.85 compatibility work is on no branch.
4. **Medium — multi-repo UI inconsistent.** `FileTreeView.tsx:69-72` + `ToolPanel.tsx:220` + `App.tsx:117-132` (git-only roots) and `App.tsx:492-500` (single-cwd watch) with a false comment at `FileTreeView.tsx:258-259`.
5. **Low — doc rot.** `docs/markdown-html-sample.md:3` ("Delete after verifying"), two unreferenced fixtures, no README link to `docs/`, onboarding relies on Chinese-only plans with no done/pending markers.
