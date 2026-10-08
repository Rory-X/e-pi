import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * End-to-end checks for E-Pi's runtime TUI hooks.
 *
 * These spawn the real sidecar Node with `--import` against the real published
 * packages, because the property under test is precisely that the injectors
 * survive upstream drift — a synthetic stub pi would prove nothing.
 */

import { applyPiCompatibilityPatches } from "../electron/main/services/pi-compatibility-service";
import { PROTOCOL } from "../resources/e-pi-tui-hooks.mjs";

const REPO = process.cwd();
const PRELOAD = join(REPO, "resources", "e-pi-tui-preload.mjs");
const HOOKS = join(REPO, "resources", "e-pi-tui-hooks.mjs");
const SIDECAR_NODE = join(REPO, "resources", "node", "bin", "node");

/**
 * Shape of a viewport OSC: the literal prefix, then scrollTop;maxScrollTop;flag.
 * Built from the hook's own constant so the assertion cannot drift from what is
 * emitted, and written with escapes so no control characters sit in the source.
 */
const VIEWPORT_OSC_SHAPE = new RegExp(
  `^${PROTOCOL.VIEWPORT_OSC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+;\\d+;[01]\\u0007$`,
);

/** Versions that must stay supported; the whole point of the hooks. */
const VERSIONS = ["0.84.2", "0.85.0", "0.85.1", "0.86.1", "0.87.1", "0.99.1", "0.99.2", "1.1.0"] as const;

const roots: string[] = [];
function temporaryDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Run a probe in the sidecar Node with the hooks installed, targeting one
 * module. Returns the parsed JSON from the probe's final stdout line.
 */
function runProbe(
  workDir: string,
  target: string,
  body: string,
  env: Record<string, string> = {},
): Record<string, unknown> {
  const scriptPath = join(workDir, "probe.mjs");
  writeFileSync(
    scriptPath,
    `import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const m = await import(pathToFileURL(process.argv[2]).href);
${body}
`,
    "utf8",
  );
  const stdout = execFileSync(SIDECAR_NODE, ["--import", PRELOAD, scriptPath, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      E_PI: "true",
      E_PI_TUI_OPTIMIZATIONS: "true",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

/**
 * Shared body: build a real `TuiAltScreen` instance on a bare prototype, with
 * enough state for upstream's `doRender` to run to completion.
 */
const HARNESS = `
const dir = process.argv[2].replace(/\\/tui-alt-screen\\.js$/, "");
const tui = await import(pathToFileURL(dir + "/tui.js").href);
const textMod = await import(pathToFileURL(dir + "/components/text.js").href);
const svMod = await import(pathToFileURL(dir + "/components/scroll-view.js").href);
const doc = new tui.Container();
doc.addChild(new textMod.Text("hello world"));
const sv = new svMod.ScrollView(doc, { follow: "end", primary: true });
const writes = [];
const inst = Object.create(m.TuiAltScreen.prototype);
inst.terminal = { write: (s) => { writes.push(s); return true; }, columns: 80, rows: 24 };
inst.stopped = false;
inst.altScreenActive = true;
inst.previousScreen = [];
inst.previousScreenWidth = 80;
inst.previousScreenHeight = 24;
inst.implicitScrollView = sv;
inst.currentLayout = null;
inst.uploadedKittyImages = new Set();
inst.imageProtocol = undefined;
inst.overlayStack = [];
inst.focusedComponent = undefined;
inst.flashes = { render: () => [] };
inst.mouseEnabled = false;
inst.searchState = undefined;
inst.requestRender = () => {};
inst.wheelScrollLines = 3;
if (typeof inst.setWheelScrollLines === "function") {
  const wheel = await import(pathToFileURL(dir + "/wheel-scroll.js").href);
  inst.wheelScroll = new wheel.WheelScrollAccelerator(3, true);
}
inst.ePiNavBlocks = [];
inst.ePiNavLabels = [];
inst.ePiNavReplies = [];
`;

type Fixture = { version: string; altScreen: string; interactiveMode: string };

const fixtures: Fixture[] = [];
let skipReason = "";

beforeAll(async () => {
  const cacheRoot = join(tmpdir(), "e-pi-hook-tarballs");
  mkdirSync(cacheRoot, { recursive: true });

  const needed = VERSIONS.flatMap((v) => [
    { name: "pi-coding-agent", spec: v },
    { name: "pi-tui", spec: v },
  ]);
  await Promise.all(
    needed.map(async ({ name, spec }) => {
      const tarball = join(cacheRoot, `${name}-${spec}.tgz`);
      if (existsSync(tarball)) return;
      try {
        const response = await fetch(`https://registry.npmjs.org/@earendil-works/${name}/-/${name}-${spec}.tgz`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`registry responded ${response.status}`);
        writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
      } catch (cause) {
        skipReason += `${name}@${spec}: ${String(cause)} `;
      }
    }),
  );

  for (const version of VERSIONS) {
    try {
      const root = temporaryDir(`e-pi-hook-${version.replace(/\./g, "-")}-`);
      const agentDir = join(root, "agent");
      mkdirSync(agentDir, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        join(cacheRoot, `pi-coding-agent-${version}.tgz`),
        "-C",
        agentDir,
        "--strip-components=1",
      ]);
      const tuiDir = join(root, "tui");
      mkdirSync(tuiDir, { recursive: true });
      execFileSync("tar", ["-xzf", join(cacheRoot, `pi-tui-${version}.tgz`), "-C", tuiDir, "--strip-components=1"]);
      // Nest pi-tui the way a real install places it.
      const nested = join(agentDir, "node_modules", "@earendil-works", "pi-tui");
      mkdirSync(dirname(nested), { recursive: true });
      renameSync(tuiDir, nested);
      // The tarballs ship no dependencies, so `interactive-mode.js` cannot be
      // imported until they are installed. Strip devDependencies/scripts first:
      // they crash npm's resolver during a standalone install.
      const pkgPath = join(agentDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      delete pkg.devDependencies;
      delete pkg.scripts;
      // 0.85.0 imports @earendil-works/pi-server from dist/experimental but
      // omits it from dependencies, so it cannot be imported until installed.
      // Same defect the update service works around for real installs.
      if (version === "0.85.0") {
        (pkg.dependencies as Record<string, string>)["@earendil-works/pi-server"] = version;
      }
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      execFileSync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          // A dedicated cache keeps the fixture independent of the host's
          // possibly root-owned ~/.npm/_cacache.
          "--cache",
          join(tmpdir(), "e-pi-npm-cache"),
        ],
        { cwd: agentDir, stdio: "ignore" },
      );
      fixtures.push({
        version,
        altScreen: join(agentDir, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-alt-screen.js"),
        interactiveMode: join(agentDir, "dist", "modes", "interactive", "interactive-mode.js"),
      });
    } catch (cause) {
      skipReason += `${version}: ${String(cause)} `;
    }
  }
}, 300_000);

describe("runtime TUI hooks", () => {
  it("ships the hook files the spawn path expects", () => {
    expect(existsSync(PRELOAD)).toBe(true);
    expect(existsSync(HOOKS)).toBe(true);
    expect(existsSync(SIDECAR_NODE)).toBe(true);
    // The preload must call register(); exporting hooks alone does nothing.
    expect(readFileSync(PRELOAD, "utf8")).toContain("register(");
  });

  for (const version of VERSIONS) {
    describe(`pi ${version}`, () => {
      const fixtureFor = () => fixtures.find((f) => f.version === version);

      it("injects and keeps synthetic-wheel math independent of upstream's wheel lines", () => {
        const fixture = fixtureFor();
        if (!fixture) {
          console.warn(`[hooks] skipping ${version} — ${skipReason.trim()}`);
          return;
        }
        const result = runProbe(
          temporaryDir(`e-pi-hook-wheel-${version}-`),
          fixture.altScreen,
          `${HARNESS}
const calls = [];
sv.scrollBy = (n) => { calls.push(n); return 0; };
sv.scrollToEnd = () => { calls.push("toEnd"); };

// Synthetic wheel: 5 requested rows must yield exactly 5, not 5 * wheelScrollLines.
inst.routeWheel({ direction: 0, lines: 5, x: 0, y: 0 });
const synthetic = calls.slice();

// Real wheel must still use upstream's wheel-lines value (3).
calls.length = 0;
inst.routeWheel({ direction: 1, button: 0, x: 0, y: 0 }, 3);
const realWheel = calls.slice();

const bottom = inst.handleViewportInput("\\x1b_e-pi:viewport:bottom\\x1b\\\\");
const unknown = inst.handleViewportInput("\\x1b_e-pi:viewport:whatever\\x1b\\\\");

console.log(JSON.stringify({
  injected: !!globalThis.__E_PI_TUI_ALT_SCREEN,
  synthetic,
  realWheel,
  bottomConsumed: bottom ? bottom.consume === true : false,
  unknownConsumed: unknown ? unknown.consume === true : false,
  linesRestored: inst.wheelScrollLines === 3,
  accessorRestored: !Object.prototype.hasOwnProperty.call(inst, "getWheelScrollLines"),
  diskUnmodified: !readFileSync(process.argv[2], "utf8").includes("__E_PI_TUI_ALT_SCREEN"),
}));
`,
        );

        expect(result.injected).toBe(true);
        expect(result.synthetic).toEqual([5]);
        // Upstream computes direction * wheelScrollLines for real events.
        expect(result.realWheel).toEqual([3]);
        expect(result.bottomConsumed).toBe(true);
        expect(result.unknownConsumed).toBe(true);
        expect(result.linesRestored).toBe(true);
        expect(result.accessorRestored).toBe(true);
        // The whole point: the file on disk is never touched.
        expect(result.diskUnmodified).toBe(true);
      }, 120_000);

      it("emits the viewport OSC inside the synchronized frame", () => {
        const fixture = fixtureFor();
        if (!fixture) return;
        const result = runProbe(
          temporaryDir(`e-pi-hook-osc-${version}-`),
          fixture.altScreen,
          `${HARNESS}
inst.doRender();
const frame = writes.join("");
console.log(JSON.stringify({
  writeCount: writes.length,
  viewport: (frame.match(/\\x1b\\]6973;[^\\x07]*\\x07/) || [null])[0],
  // One write per frame keeps the OSC atomic with the frame it describes.
  atomic: frame.includes("\\x1b[?2026h") && frame.indexOf("\\x1b]6973") < frame.indexOf("\\x1b[?2026l"),
}));
`,
        );

        expect(result.writeCount).toBe(1);
        expect(String(result.viewport)).toMatch(VIEWPORT_OSC_SHAPE);
        expect(result.atomic).toBe(true);
      }, 120_000);

      it("is a complete no-op while the optimization is disabled", () => {
        const fixture = fixtureFor();
        if (!fixture) return;
        const result = runProbe(
          temporaryDir(`e-pi-hook-off-${version}-`),
          fixture.altScreen,
          `${HARNESS}
inst.doRender();
const frame = writes.join("");
const escape = inst.handleViewportInput("\\x1b_e-pi:viewport:bottom\\x1b\\\\");
const wheelCalls = [];
sv.scrollBy = (n) => { wheelCalls.push(n); return 0; };
inst.routeWheel({ direction: 1, button: 0, x: 0, y: 0 }, 3);
console.log(JSON.stringify({
  hasViewportOsc: frame.includes("\\x1b]6973;"),
  hasNavOsc: frame.includes("\\x1b]6974;"),
  // Must not consume our private escapes when disabled.
  escapeConsumed: escape ? escape.consume : null,
  wheelCalls,
}));
`,
          { E_PI_TUI_OPTIMIZATIONS: "false" },
        );

        expect(result.hasViewportOsc).toBe(false);
        expect(result.hasNavOsc).toBe(false);
        expect(result.escapeConsumed).not.toBe(true);
        expect(result.wheelCalls).toEqual([3]);
      }, 120_000);

      it("suppresses the above-editor spacer only when enabled", () => {
        const fixture = fixtureFor();
        if (!fixture || !existsSync(fixture.interactiveMode)) return;
        const result = runProbe(
          temporaryDir(`e-pi-hook-widgets-${version}-`),
          fixture.interactiveMode,
          `const P = m.InteractiveMode.prototype;
// Observe what the wrapper passes down by re-wrapping it. Real Containers are
// used because the upstream implementation calls container.clear().
const tui = await import(pathToFileURL(
  process.argv[2].replace(/\\/dist\\/modes\\/interactive\\/interactive-mode\\.js$/, "/node_modules/@earendil-works/pi-tui/dist/tui.js"),
).href);
const inst = Object.create(P);
const above = new tui.Container();
const below = new tui.Container();
inst.widgetContainerAbove = above;
inst.widgetContainerBelow = below;
// Spying on addChild observes what upstream actually does: the spacer branch
// adds a Spacer, the non-spacer branch adds nothing for an empty widget set.
const added = [];
for (const c of [above, below]) {
  const origAdd = c.addChild.bind(c);
  c.addChild = (child) => {
    added.push({ container: c === above ? "above" : "below", type: child?.constructor?.name ?? "?" });
    return origAdd(child);
  };
}
inst.renderWidgetContainer(above, new Set(), true, true);
inst.renderWidgetContainer(below, new Set(), true, true);
console.log(JSON.stringify({
  injected: !!globalThis.__E_PI_TUI_INTERACTIVE_MODE,
  aboveSpacer: added.some((a) => a.container === "above" && a.type === "Spacer"),
  belowSpacer: added.some((a) => a.container === "below" && a.type === "Spacer"),
}));
`,
        );

        expect(result.injected).toBe(true);
        // Above the editor: no empty-state spacer, because E-Pi owns the dock.
        expect(result.aboveSpacer).toBe(false);
        // Below: upstream behavior untouched, so it still reserves one.
        expect(result.belowSpacer).toBe(true);
      }, 120_000);
    });
  }

  it.each(["0.99.1", "1.1.0"])(
    "keeps %s wheel acceleration and Alt scrolling while host deltas bypass acceleration",
    (version) => {
      const fixture = fixtures.find((f) => f.version === version);
      expect(fixture).toBeDefined();
      const result = runProbe(
        temporaryDir("e-pi-hook-099-wheel-"),
        fixture!.altScreen,
        `${HARNESS}
const calls = [];
sv.scrollBy = (n) => { calls.push(n); return 0; };
inst.createMouseEvent = () => ({});
inst.dispatchMouseToOverlay = () => ({ hit: false });
inst.dispatchMouseToLayout = () => undefined;
inst.shouldDeferViewportInputToOverlay = () => false;
inst.wheelScroll.setLines(3);
inst.handleViewportInput("\\x1b[<65;1;1M");
inst.handleViewportInput("\\x1b[<73;1;1M");
const native = calls.splice(0);
inst.wheelScroll.setLines("auto");
inst.wheelScroll.next(1, 1000);
const before = inst.wheelScroll.lastTime;
inst.handleViewportInput("\\x1b_e-pi:viewport:wheel:v1;-7;0;0\\x1b\\\\");
console.log(JSON.stringify({native, host: calls, untouchedGesture: inst.wheelScroll.lastTime === before,
  accelerated: inst.wheelScroll.next(1, 1020)}));
`,
      );
      expect(result).toEqual({ native: [3, 15], host: [-7], untouchedGesture: true, accelerated: 5 });
    },
  );

  it.each(["0.99.1", "1.1.0"])(
    "emits one viewport and navigator payload when the %s text patch and hooks run together",
    (version) => {
      const fixture = fixtures.find((f) => f.version === version);
      expect(fixture).toBeDefined();
      // Stock-hook cases above run first. Now exercise the combination actually
      // spawned by E-Pi: both published packages patched, plus the preload.
      const agentDir = fixture!.interactiveMode.replace(/\/dist\/modes\/interactive\/interactive-mode\.js$/, "");
      applyPiCompatibilityPatches(agentDir);
      const result = runProbe(
        temporaryDir("e-pi-hook-099-patched-"),
        fixture!.altScreen,
        `${HARNESS}
for (let i = 1; i < 40; i++) doc.addChild(new textMod.Text("line " + i, 0, 0));
inst.ePiNavBlocks = [doc.children[0]];
inst.ePiNavLabels = ["hello\\x1b]2;forged\\x07,|;"];
inst.ePiNavReplies = ["reply"];
inst.doRender();
const frame = writes.join("");
const navInput = inst.handleViewportInput("\\x1b_e-pi:viewport:scrollto:v1;1\\x1b\\\\");
await new Promise((resolve) => setTimeout(resolve, 200));
const navJumped = navInput?.consume === true && sv.scrollTop === 0 && !sv.isFollowingEnd;
const calls = [];
sv.scrollBy = (n) => { calls.push(n); return 0; };
inst.handleViewportInput("\\x1b_e-pi:viewport:wheel:v1;5;0;0\\x1b\\\\");
console.log(JSON.stringify({
  writeCount: writes.length, viewportCount: frame.split("\\x1b]6973;").length - 1,
  navCount: frame.split("\\x1b]6974;").length - 1,
  atomic: frame.indexOf("\\x1b]6973;") < frame.indexOf("\\x1b[?2026l"),
  forged: frame.includes("\\x1b]2;forged"), calls, navJumped,
}));
`,
      );
      expect(result).toEqual({
        writeCount: 1,
        viewportCount: 1,
        navCount: 1,
        atomic: true,
        forged: false,
        calls: [5],
        navJumped: true,
      });
    },
  );
});
