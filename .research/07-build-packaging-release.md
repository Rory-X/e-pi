# E-Pi — Build, Packaging & Release

E-Pi bundles with electron-vite into three targets and packages with electron-builder from an inline config in `package.json` — no dedicated builder file, no CI. macOS is ad-hoc signed only (`identity: null` plus an `afterPack` re-sign that exists purely for notification identity), so releases ship unsigned and un-notarized and the README tells users to run `xattr -cr`. A 120 MB Node/npm sidecar fetched by `scripts/fetch-node.mjs` is shipped so package installs work without Node on the user's PATH, and five hand-maintained patches against minified upstream `dist` JS are re-applied at runtime by `pi-compatibility-service`. The largest structural problem is that the working tree is dirty exactly where it matters: `scripts/after-pack.mjs`, `pnpm-workspace.yaml`, the 0.85.x patches and the TUI hook resources are untracked, so a clean checkout of HEAD cannot build the app that exists on disk.

## Findings

**Bundler config (`electron.vite.config.ts`, 47 lines)**

- Entries: main → `electron/main/index.ts` (electron.vite.config.ts:15), preload → `electron/preload/index.ts` (:23), renderer → `index.html` (:37).
- `externalizeDepsPlugin()` on main and preload only (:12, :20): everything in `dependencies` stays external and resolves from `node_modules` at runtime. Load-bearing for `node-pty` (package.json:49), imported at electron/main/services/pi-runtime.ts:8 and side-terminal-service.ts:5 — externalizing keeps the native `.node` out of the bundle.
- Preload forced to CJS via `entryFileNames: "[name].cjs"` (:25-27); main loads exactly that name — `preload: join(__dirname, "../preload/index.cjs")` (electron/main/index.ts:579). Renaming either side silently breaks IPC.
- Renderer uses `react()` + `tailwindcss()` (:33), alias `@` → `./src` (:42-44) built from `new URL("./src", import.meta.url).pathname` (:43) — `.pathname` is not percent-decoded, so a checkout path with spaces breaks the alias.
- `tsconfig.json` is one project (`noEmit: true`, :12) over electron/resources/src/test (:19-27); `strict: true` (:8); no node/web split.
- `vitest.config.ts`: `environment: "node"` over `test/**/*.test.ts` (:5-6) — no DOM env, so no renderer component is covered.

**Packaging (inline in `package.json`)**

- `"build"` at package.json:96-187; `main: "out/main/index.js"` (:9); appId `works.earendil.e-pi`, productName `E-Pi` (:97-98).
- Targets: mac `dmg`+`zip` (:168-171), win `nsis`+`portable` (:175-178), NSIS opts :180-186. No linux target.
- `asar: true` with `asarUnpack: ["node_modules/**"]` (:100-103) opts the whole dep tree out of the archive: built app is 569 MB, `dist/` is 953 MB, dmg 197 MB, sidecar 120 MB.
- `files` (:104-121) trims maps/docs/native prebuilds. The excludes are unconditional and platform-specific: `!node_modules/node-pty/prebuilds/win32-*/**` and `!node_modules/@earendil-works/pi-tui/native/win32/**` (:118, :116) also apply to win builds, since `dist:mac`/`dist:win` share one config.
- `extraResources` (:122-163) ships `e-pi-bridge.ts`, `e-pi-tui-preload.mjs`, `e-pi-tui-hooks.mjs`, `e-pi-light.json`, five patches into `pi-compatibility/<filename>.patch`, and `resources/node` → `node`. The `!resources/node/**` exclude (:107) stops the 120 MB tree being packed twice.
- Consumers resolve by existence, not a packaged flag: pi-runtime.ts:91 (`join(process.resourcesPath, "node", "bin", "node")`), :71 (preload), pi-compatibility-service.ts:350-353 (patches), pi-runtime.ts:56 (bridge).
- `scripts/after-pack.mjs` (19 lines) runs `/usr/bin/codesign --force --deep --sign - <app>` then verifies (:17-18), darwin-only (:14). Comment :4-12: with `identity: null` the ad-hoc identifier stays "Electron", so macOS cannot attribute notifications to E-Pi.
- No `publish`/notarize/`afterSign` config; `electron-updater` is absent and `autoUpdater` is never referenced. Yet electron-builder emits `dist/latest-mac.yml` and the bundle contains `Contents/Resources/app-update.yml` — auto-update metadata with nothing behind it.
- `dist/builder-effective-config.yaml` is a stale leftover (Aug 10 vs. Sep 6 artifacts): it names `pi-coding-agent@0.84.0.patch` and `to: pi-compatibility/pi-coding-agent.patch`, filenames the current service no longer prefers.
- **HEAD ≠ working tree.** `git diff package.json` shows `afterPack`, the TUI-hook resources and the renamed `pi-compatibility/@…@<ver>.patch` destinations uncommitted; `git status --short` lists `scripts/after-pack.mjs`, `pnpm-workspace.yaml`, three 0.85.x patches, `resources/e-pi-tui-hooks.mjs` and `resources/e-pi-tui-preload.mjs` as untracked. `git show HEAD:package.json` still carries a `pnpm.patchedDependencies` block (HEAD:96-105) the working tree deleted.

**Bundled Node sidecar**

- Rationale (scripts/fetch-node.mjs:2-11): Finder-launched apps have no PATH, so installs fail with `spawn npm ENOENT`; npm-path.ts:34-39 prepends `Contents/Resources/node/bin` to PATH at runtime, packaged only (:35).
- Fetches `https://nodejs.org/dist/<v>/node-<v>-<platform>-<arch>.tar.gz` (:33, :46), pin `v22.23.2` with `NODE_VERSION` override (:33). **No checksum or signature verification** (:48-69).
- Extracts with `tar -xf` even for the Windows zip (:44, :78), relying on bsdtar; copies only `bin/node` plus the npm CLI, deletes npm `docs`/`man` (:84-92), then writes its own `npm`/`npx` launchers because tarball symlinks point into the deleted temp dir (:85-87, :115-130).
- Host-only coverage: tuple from `process.platform`/`process.arch` (:35-39); the `linux` entry is dead code (no linux target) and `.cmd` launchers are written only on Windows (:116).
- `.gitignore:5` ignores `resources/node/`; generator writes a nested ignore-all plus README (:103-113, matching resources/node/.gitignore and README.md). Docs say `v22.12.0` (fetch-node.mjs:10, :111; resources/node/README.md:7) while the code pins `v22.23.2`.

**Patches and runtime re-application**

- `pnpm-workspace.yaml:4-6` declares `patchedDependencies` for `pi-coding-agent@0.84.2` and `pi-tui@0.84.2` only; `onlyBuiltDependencies` :1-3 covers electron/node-pty. The 0.85.x patches are deliberately not install-time patched — they are applied post-install to whatever Pi version the user has.
- Runtime applier `electron/main/services/pi-compatibility-service.ts`: profiles `"0.84"` (:69) and `"0.85"` (:86), each with exact version-matched filenames and marker probes (:357-377); cross-version patches are refused on purpose (:358-363); `applyPiCompatibilityPatches` plans both files before writing (:394-405).
- Content: agent patches rewrite `dist/modes/interactive/interactive-mode.js` and, in 0.85, `chat-viewport.js`; pi-tui patches (~34 KB each) touch `markdown.js`, `scroll-view.js` (a 408-line hunk), `text.js`, `layout.js`, `tui-alt-screen.js`, `tui.js` — virtual scrolling plus E-Pi's OSC viewport/nav protocol.
- Three near-duplicate pi-tui variants (0.84.2 / 0.85.0 / 0.85.1, 87 KB); 0.85.1 exists only because upstream "rewrote the wheel-scroll expression the tui patch anchors on" (:62-66). Filenames duplicated between `extraResources` (package.json:139-158) and the profiles (:68-101), no shared constant.
- `resources/e-pi-tui-hooks.mjs` (15 KB) is the intended escape hatch: an in-memory `--import` loader-hook rewrite (:56-60; e-pi-tui-preload.mjs:22) moving logic off the patch surface.

**Quality gates and release**

- `.husky/pre-commit` is two lines: `npx lint-staged` and `npm run typecheck` — npx/npm inside a pnpm repo. `lint-staged` (package.json:91-94) runs `oxlint --fix` on ts/tsx and `oxfmt` on md/json. Tests are in `build` (package.json:17) but not the hook.
- `.oxlintrc.json`: correctness/suspicious = error, perf = warn (:3-8), ignores out/dist/release (:13). `.oxfmtrc.json`: 120 cols, `sortImports`, Tailwind class sorting bound to `src/styles/app.css` (:3-10).
- **No CI exists.** `ls .github` → "No such file or directory"; no CircleCI/Travis/GitLab/Azure/AppVeyor config; only root YAML is `pnpm-lock.yaml` and `pnpm-workspace.yaml`. README:180 suggests a CI workflow as the "simplest approach" — a suggestion, not a checked-in file.
- Publication is manual: `dist:mac`/`dist:win` (package.json:19, :21) on a developer machine, so README:45's Releases claim depends on someone doing it by hand. `dist:win` has never been validated here — `dist/` holds only arm64 mac artifacts.

## Risks

1. **High — untracked build-critical files; HEAD does not build.** `scripts/after-pack.mjs`, `pnpm-workspace.yaml`, three 0.85.x patches and `resources/e-pi-tui-{hooks,preload}.mjs` are untracked, and the `package.json` edits referencing them are uncommitted. A clean clone loses the ad-hoc re-sign step, the pnpm patch declarations and the TUI hooks the compatibility service expects. Commit these before any release cut.
2. **High — unsigned, un-notarized macOS builds.** `mac.identity: null` (package.json:167), no notarize block, and README:55-69 instructs `xattr -cr /Applications/E-Pi.app` while admitting "every fresh download gets quarantined again". `afterPack` re-signs ad-hoc only for notification identity (after-pack.mjs:4-12), not the trust chain; hardened-runtime or MDM deployment fails outright.
3. **High — no CI, unverified Windows path.** Artifacts are hand-built and `dist:win` needs a Windows host (README:172-173 mentions Wine). Together with the unconditional win32 native excludes (package.json:116-119), the Windows config has a plausible correctness bug nothing in the repo can catch.
4. **Medium — maturity signals contradict the README.** `version: "0.1.0"` and `private: true` (package.json:3-4) against a feature-complete README and public Releases; artifacts are literally `E-Pi-0.1.0-arm64.dmg`.
5. **Medium — bundle size.** `asarUnpack: ["node_modules/**"]` (package.json:101-103) nullifies asar compression for the dep tree: 569 MB app, 953 MB `dist/`, 197 MB dmg, 120 MB of it one Node binary. Per-platform `files` excludes are the only lever and are hand-edited.
6. **Medium — patch maintenance cost.** Five patch files against minified `dist` JS, version-exact matching (pi-compatibility-service.ts:357-377), filenames duplicated across `extraResources` and the profiles, three parallel pi-tui variants already. Each upstream patch release needs hand-regenerated patches; failure is "optimization silently disabled" or a hard `PI_COMPATIBILITY_REQUIRED_PREFIX` error (pi-update-service.ts:252-256).
7. **Medium — supply-chain gap.** `fetch-node.mjs` downloads from nodejs.org with no checksum verification (:48-69), and the documented Node version (`v22.12.0`) does not match the pin (`v22.23.2`, :33).
8. **Low — stale release metadata.** `dist/builder-effective-config.yaml` references patch filenames that no longer exist; `latest-mac.yml` and packaged `app-update.yml` imply auto-update with no code behind it.
9. **Low — platform gap.** `fetch-node.mjs` supports `linux` (:37) with no linux target, and a mac-built Windows artifact would embed a darwin sidecar. Neither `out/` nor `dist/` is tracked (`git ls-files out dist release` → 0 files), so outputs cannot leak into commits but also cannot serve as a rollback source.
