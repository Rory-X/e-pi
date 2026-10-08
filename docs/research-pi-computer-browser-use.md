# Research: Adding computer use and browser use to Pi

Date: 2026-08-13
Scope: How to give [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) (and therefore E-Pi) desktop GUI control and real-browser control. Primary sources: Pi extension/package docs, community package READMEs, [pi.dev/packages](https://pi.dev/packages).

## Bottom line

Pi does **not** ship computer use or browser use. The official extension point is already enough: a TypeScript extension calls `pi.registerTool()`, and a Pi package is installed with `pi install npm:<pkg>` or `pi install git:github.com/...`. E-Pi already wraps that installer in its package panel and loads the same `~/.pi/agent` tree as the CLI.

Do **not** write a custom driver first. Pick one package from each layer below, install it, then only add E-Pi UI if the setup flow (TCC permissions, Chrome extension load, `/chrome authorize`) is too painful.

Recommended starting stack for E-Pi on this machine (macOS, Pi 0.84.0):

| Need                                                           | Install                                     | Why                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated browser for the agent                                | `pi install npm:pi-agent-browser-native`    | One native `agent_browser` tool, token-cheap, requires Pi ≥ 0.84.0 (E-Pi already pins 0.84.0). Upstream is Vercel `agent-browser`.             |
| Logged-in Chrome (GitHub, internal admin, cookies, extensions) | `pi install npm:pi-chrome`                  | Attaches to the Chrome profile you already use. Session-gated with `/chrome authorize`.                                                        |
| Desktop apps (Finder, Slack, native IDEs, Settings)            | `pi install npm:@injaneity/pi-computer-use` | Semantic AX/UIA/AT-SPI, macOS 14+ / Windows / Linux. Also treats CDP pages as roots, so it can cover some browser work without a second stack. |

Do **not** install several browser packages at once. Tool schemas are paid on every turn. A 50-tool Playwright surface plus computer-use plus MCP Playwright will burn context before the first click.

`pi-web-access` (222K/mo on the catalog) is **search/fetch**, not browser use. Keep it if you want “find information”; it does not click, type, or drive SPAs.

## How Pi is extended (official)

From Pi’s own docs:

- Extensions are TypeScript modules. They register LLM-callable tools with `pi.registerTool()`, commands with `pi.registerCommand()`, and can subscribe to lifecycle events. Placement: `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project). Hot-reload with `/reload`. Source: [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
- Shareable units are **Pi packages**. Install:

  ```bash
  pi install npm:@foo/bar@1.0.0
  pi install git:github.com/user/repo@v1
  pi install /absolute/path/to/package
  pi -e npm:@foo/bar          # try without writing settings
  ```

  User installs land in `~/.pi/agent/settings.json` and `~/.pi/agent/npm/`. `-l` writes project `.pi/settings.json`. Source: [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

- Security warning from the same doc: packages run with full system access. Review source before installing third-party packages. Catalog: [pi.dev/packages](https://pi.dev/packages) (5,575 packages as of this research; quality varies).

E-Pi already implements this path:

- `electron/main/services/package-service.ts` wraps Pi’s `DefaultPackageManager` (list / search npm `pi-package` keyword / install / remove / update).
- `electron/main/services/command-service.ts` discovers extension commands the same way Pi does: configured packages + `~/.pi/agent/extensions` + project `.pi/extensions`.
- Agent dir resolution mirrors Pi: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.

So “add computer/browser use to E-Pi” is first a **package install**, not an Electron feature.

## Computer use (desktop GUI)

Three community packages. They are not interchangeable.

### 1. `@injaneity/pi-computer-use` — default pick

- Catalog: [pi.dev/packages/@injaneity/pi-computer-use](https://pi.dev/packages/@injaneity/pi-computer-use) — v0.5.0, 2,410/mo, MIT.
- Install: `pi install npm:@injaneity/pi-computer-use`
- Platforms: macOS 14+ (helper app `~/Applications/pi-computer-use.app`, Accessibility + Screen Recording), Windows (interactive desktop, UIA), Linux (AT-SPI2; X11 can do capture + gated XTEST; Wayland is semantic-only).
- Public tools (compact, progressive disclosure): `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`. Older `screenshot` / `click` / `set_text` / `computer_actions` are **no longer** the public surface.
- Architecture: one multi-root forest. Desktop windows **and CDP browser pages** are roots (`@rN`). Observe produces an immutable tree (`@eN` + `stateId`). `act_ui` is a verified transaction with optional `expect` postcondition. Stale writes are rejected by resource epoch. Source: [docs/architecture.md](https://raw.githubusercontent.com/injaneity/pi-computer-use/main/docs/architecture.md).
- In-Pi command: `/computer-use` shows effective config.
- Implication: if you want **one** agent surface for both desktop and browser, this package already unifies them. Pairing it with a second 50-tool browser extension is usually waste.

### 2. `@lallenlowe/pi-computer-use` — macOS fork, Codex-style

- Fork of injaneity. From v0.3.0 it is a separate project. Not on public npm; install from git:

  ```bash
  pi install git:github.com/lallenlowe/pi-computer-use@v0.3.0
  ```

- macOS only. Helper: `~/.pi/agent/helpers/pi-computer-use/bridge`. Accessibility + Screen Recording.
- Public tools are the older primitive set: `list_apps`, `list_windows`, `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `arrange_window`, `computer_actions`, `apple_script`, `wake_window`, `surface_window`, `launch_app`.
- Differentiator: **per-PID input** — clicks/keys land in the target app’s queue without stealing the user’s frontmost window or moving the system cursor. Focus-changing tools (`surface_window`, `launch_app({activate:true})`) go through `ctx.ui.confirm` unless `focus_auto_approve`.
- Prefer this if the product requirement is “invisible Codex-style computer use on macOS” and you want the primitive tool names. Prefer injaneity if you want cross-platform + fewer tools + CDP-as-roots.

### 3. `pi-peekaboo` — argv bridge to Peekaboo CLI

- Catalog: [pi.dev/packages/pi-peekaboo](https://pi.dev/packages/pi-peekaboo) — v0.1.1.
- Install: `pi install npm:pi-peekaboo`
- Requires macOS 15+ and `brew install steipete/tap/peekaboo`. Session gate: `/peekaboo` on, `/peekaboo off`. One `peekaboo({ args: [...] })` tool covering capture, AX, click/type, app/window, and Peekaboo’s own browser MCP.
- Use if Peekaboo is already the house standard. Otherwise injaneity is the more self-contained Pi package.

## Browser use

The landscape splits on **which Chrome** the agent drives, and **how many tools** it exposes.

### Axis: which browser

| Approach                | Package                                                            | Browser identity                                     | Auth / cookies                     |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------- |
| Dedicated Chromium      | `pi-agent-browser-native`, `pi-agent-browser`, `pi-browser-search` | Fresh/headless Chromium                              | Empty unless you persist a profile |
| Attach via CDP          | `larsderidder/pi-browser`, `pi-chrome-use`                         | Any Chromium launched with `--remote-debugging-port` | Whatever that instance has         |
| Live inside your Chrome | `pi-chrome`                                                        | The profile you already use                          | Full: SSO, MFA device, extensions  |

`pi-chrome`’s own comparison doc is the clearest statement of this split: Playwright/Puppeteer launch throwaway profiles; pointing them at your real `user-data-dir` requires closing Chrome; a Chrome extension bridge does not fight the profile lock. Source: [docs/COMPARISON.md](https://raw.githubusercontent.com/tianrendong/pi-chrome/main/docs/COMPARISON.md).

### Axis: tool-count / token cost

| Style                            | Example                                                                                                          | Cost                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| One native tool, CLI-shaped args | `pi-agent-browser` (`browser`), `pi-agent-browser-native` (`agent_browser`), `pi-chrome-use` (`browser_execute`) | Cheap in the system prompt                                    |
| Four task tools                  | `pi-browser-search` (`browser_search/open/act/read`)                                                             | Moderate                                                      |
| Playwright-MCP-shaped 50+ tools  | `larsderidder/pi-browser`                                                                                        | Expensive every turn                                          |
| MCP proxy (discover on demand)   | `pi-mcp-adapter` + `chrome-devtools-mcp`                                                                         | One `mcp` tool (~200 tokens) until you opt into `directTools` |

Mario’s argument against dumping MCP tool schemas into context is why `pi-mcp-adapter` exists (354K/mo on the catalog). Same argument applies to 50 Playwright tools registered natively.

### Package notes

**`pi-agent-browser-native`** (fitchmultz) — [pi.dev/packages/pi-agent-browser-native](https://pi.dev/packages/pi-agent-browser-native), 13.8K/mo, v0.3.0.

```bash
# upstream first
# https://agent-browser.dev / https://github.com/vercel-labs/agent-browser
pi install npm:pi-agent-browser-native
```

Requires Pi **0.84.0+** (E-Pi’s `package.json` pins `@earendil-works/pi-coding-agent` 0.84.0). Does not bundle `agent-browser`; it must be on `PATH`. Native tool `agent_browser`. Optional web-search config under `~/.pi/config/pi-agent-browser-native/config.json`. Doctor: `npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor`.

**`pi-agent-browser`** (coctostan) — v0.1.0, 661/mo. Single-file wrapper, auto-installs `agent-browser` + Chromium on first use. Simpler, less maintained than the native package. Fine for a smoke test (`pi -e npm:pi-agent-browser`).

**`pi-chrome`** (tianrendong) — [pi.dev/packages/pi-chrome](https://pi.dev/packages/pi-chrome), v0.15.46, 2,566/mo, **0 runtime deps**.

```bash
pi install npm:pi-chrome
# then in Pi: /chrome onboard → load unpacked extension → /reload → /chrome doctor → /chrome authorize
```

Loopback bridge `127.0.0.1:17318`. Tools locked until `/chrome authorize` (default 15 minutes). Not OS automation: no print dialogs, permission bubbles, passkeys, native Chrome chrome. For strict-CSP pages, screenshot + coordinates.

**`pi-chrome-use`** (CitroLabs) — `pi install npm:pi-chrome-use`, 170/mo. One `browser_execute` tool (BrowserCode / CDP JS). Persistent CDP session inside the Pi process. Inspired by browser-use/browsercode and agent-browser. Use when you want “write a snippet against CDP”, not a click/snapshot loop.

**`larsderidder/pi-browser`** — clone into `~/.pi/agent/extensions`, `npm install`. Playwright over CDP. 50+ tools (`browser_navigate`, `browser_snapshot`, `browser_click`, cookies, localStorage, network route, …). Attach to a running Chrome with `--remote-debugging-port=9222`, or `/browser launch`. Closest to Playwright MCP’s tool list. Highest token tax. Firefox unsupported.

**`pi-browser-search`** (sebaxzero) — `pi install npm:pi-browser-search`. Four tools, Playwright Chromium, prompt-injection sanitization + network-level SSRF. **Blocks RFC-1918 / loopback**, so it cannot test localhost frontends (author points at `pi-frontend-check` for that). Good for “search the public web and poke JS-heavy pages” with a threat model; bad as a general app-dev browser.

**Skills, not tools:** `guwidoe/pi-playwright` adds a `playwright-browser` **skill** that shells out to `@playwright/cli`. Token-efficient (no tool schemas) but the model must remember to load the skill and run CLI commands. Weaker than a native tool for multi-step UI.

**Also seen, not recommended as the first install:** `@amaster.ai/pi-browser-use` (wraps `chrome-devtools-mcp` and prefixes tools `browser_`), `@pankajudhas81/pi-browser` / `pi-browser-tools` (shared Playwright Chromium across Pi sessions), `@dreki-gg/pi-browser-tools` (Playwright or agent-browser via `PI_BROWSER_BACKEND`). Overlap with the packages above; catalog quality is mixed.

## MCP as a third path

Pi has no built-in MCP client. Two community adapters:

| Package            | Catalog traffic | Model-facing surface                                                                 |
| ------------------ | --------------- | ------------------------------------------------------------------------------------ |
| `pi-mcp-adapter`   | 354.4K/mo       | One `mcp({ search, tool, args })` proxy; servers lazy-start. Optional `directTools`. |
| `@0xkobold/pi-mcp` | lower           | Auto-registers every MCP tool as `mcp_<server>_<tool>`                               |

`pi-mcp-adapter`’s own README uses **chrome-devtools-mcp** as the example server:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0"]
    }
  }
}
```

Then: `mcp({ search: "screenshot" })` → `mcp({ tool: "chrome_devtools_take_screenshot", args: { format: "png" } })`.

This is the right path if E-Pi already wants a general MCP story (databases, Figma, Playwright MCP, etc.). It is the wrong path if the only goal is browser use — a native Pi package will have better TUI rendering, image results, and fewer moving parts.

Playwright MCP (`@playwright/mcp`) and Chrome DevTools MCP are both usable **behind** `pi-mcp-adapter`. They are not Pi extensions themselves.

## What E-Pi should and should not build

E-Pi is “a focused desktop shell for Pi sessions, packages, and terminal workflows” (README). Package install already exists. That is the integration.

**Do now (no E-Pi code):**

1. Install one browser package and one computer-use package via the Packages panel or `pi install`.
2. Complete OS / Chrome setup (TCC on the **helper app**, not on `E-Pi.app`; Chrome unpacked extension for `pi-chrome`).
3. Confirm a vision-capable model is selected if you want screenshots as image tool results.
4. Restart or `/reload` the Pi session so the new tools appear.

**Maybe later (E-Pi product, not a new driver):**

- One-click “enable browser use / computer use” that runs the same `DefaultPackageManager.install` E-Pi already has, then opens a setup checklist (TCC, `/chrome onboard`).
- Surface `/chrome authorize` and `/computer-use` status in the session chrome so users are not hunting TUI commands.
- Warn in the package panel when two overlapping browser packages are enabled.

**Do not:**

- Reimplement Playwright/CDP/AX inside Electron. The community packages already talk to Pi’s `registerTool` and return image content Pi understands.
- Grant Accessibility to `E-Pi.app` expecting `@injaneity/pi-computer-use` to work. The helper is `~/Applications/pi-computer-use.app` (or the lallenlowe bridge binary).
- Enable `pi-browser-search` as the app-dev browser. Its SSRF guard blocks localhost.
- Register Playwright MCP’s full tool list as direct tools. Use the adapter proxy, or a native one-tool package.

**Multi-session caveat:** E-Pi runs one Pi process per session. Browser packages differ:

- `pi-agent-browser*` typically one Chromium per Pi process (cleanup on `session_shutdown`).
- `larsderidder/pi-browser` and some `pi-browser-tools` attach to a **shared** CDP port — concurrent sessions can stomp tabs.
- `pi-chrome` is designed for multi-session shared Chrome with per-session automation targets.

Pick the isolation model on purpose.

## Suggested decision tree

```text
Need to operate a website?
├── Must use MY logged-in Chrome (SSO, cookies, extensions)
│     → pi-chrome
├── Must test localhost / the app I'm developing
│     → pi-agent-browser-native  (or injaneity computer-use CDP roots)
│     ✗ not pi-browser-search (SSRF blocks private IPs)
├── Public web + injection/SSRF threat model
│     → pi-browser-search  (+ optional pi-web-access for cheap fetch)
└── Already standardized on MCP
      → pi-mcp-adapter + chrome-devtools-mcp or @playwright/mcp
          (proxy tool, not directTools)

Need to operate a desktop app (not a browser)?
├── macOS + want invisible per-PID input
│     → git:github.com/lallenlowe/pi-computer-use@v0.3.0
├── Already use Peekaboo
│     → pi-peekaboo
└── Default / cross-platform / also some browser
      → npm:@injaneity/pi-computer-use
```

## Security (all of these are powerful)

- Pi packages execute as the user. Catalog warning applies.
- Computer use: Accessibility + Screen Recording. The agent can click anything the OS will allow, including other apps’ dialogs.
- CDP (`--remote-debugging-port`): unauthenticated local control of the whole browser. Easy to misconfigure.
- `pi-chrome`: unpacked extension with tabs/scripting/debugger. Bridge is loopback-only and session-gated; still install only from a source you trust. Review `extensions/chrome-profile-bridge/browser-extension/` before Load unpacked.
- `pi-browser-search` is the only package in this set with a serious prompt-injection + SSRF story. The others will happily fetch whatever the model asks.

## Sources

Official Pi:

- [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [pi.dev/packages](https://pi.dev/packages)

Computer use:

- [injaneity/pi-computer-use README](https://raw.githubusercontent.com/injaneity/pi-computer-use/main/README.md) and [architecture.md](https://raw.githubusercontent.com/injaneity/pi-computer-use/main/docs/architecture.md)
- [lallenlowe/pi-computer-use README](https://raw.githubusercontent.com/lallenlowe/pi-computer-use/main/README.md)
- [pi-peekaboo on pi.dev](https://pi.dev/packages/pi-peekaboo)

Browser use:

- [tianrendong/pi-chrome README](https://raw.githubusercontent.com/tianrendong/pi-chrome/main/README.md) and [COMPARISON.md](https://raw.githubusercontent.com/tianrendong/pi-chrome/main/docs/COMPARISON.md)
- [coctostan/pi-agent-browser README](https://raw.githubusercontent.com/coctostan/pi-agent-browser/main/README.md)
- [pi-agent-browser-native on pi.dev](https://pi.dev/packages/pi-agent-browser-native)
- [citrolabs/pi-chrome-use README](https://raw.githubusercontent.com/citrolabs/pi-browser-cdp-extension/main/README.md)
- [larsderidder/pi-browser README](https://raw.githubusercontent.com/larsderidder/pi-browser/main/README.md)
- [sebaxzero/pi-browser-search README](https://raw.githubusercontent.com/sebaxzero/pi-browser-search/main/README.md)
- [guwidoe/pi-playwright README](https://raw.githubusercontent.com/guwidoe/pi-playwright/main/README.md)

MCP:

- [nicobailon/pi-mcp-adapter README](https://raw.githubusercontent.com/nicobailon/pi-mcp-adapter/main/README.md)
- [0xKobold/pi-mcp README](https://raw.githubusercontent.com/0xKobold/pi-mcp/main/README.md)
