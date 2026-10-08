import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  applyPiCompatibilityPatches,
  applyUnifiedPatch,
  canLoadPiPackage,
  hasPiCompatibilityPatch,
  isPiCompatibilityApplied,
  preparePiPackageForMode,
} from "../electron/main/services/pi-compatibility-service";

const roots: string[] = [];
/** Fixtures shared by the published-package cases; cleaned up after all of them. */
const sharedRoots: string[] = [];

function temporaryDir(name: string, shared = false): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  (shared ? sharedRoots : roots).push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.E_PI_COMPATIBILITY_PATCH_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const root of sharedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("applyUnifiedPatch", () => {
  it("applies multiple hunks after upstream line offsets", () => {
    const root = temporaryDir("e-pi-unified-");
    writeFileSync(join(root, "sample.js"), "upstream\nalpha\nbeta\ngamma\n", "utf8");

    applyUnifiedPatch(
      root,
      [
        "diff --git a/sample.js b/sample.js",
        "--- a/sample.js",
        "+++ b/sample.js",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+patched",
        "@@ -3,1 +3,2 @@",
        " gamma",
        "+tail",
        "",
      ].join("\n"),
    );

    expect(readFileSync(join(root, "sample.js"), "utf8")).toBe("upstream\nalpha\npatched\ngamma\ntail\n");
  });

  it("does not write a file when a hunk conflicts", () => {
    const root = temporaryDir("e-pi-unified-conflict-");
    const target = join(root, "sample.js");
    writeFileSync(target, "upstream changed\n", "utf8");

    expect(() =>
      applyUnifiedPatch(
        root,
        "diff --git a/sample.js b/sample.js\n--- a/sample.js\n+++ b/sample.js\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    ).toThrow("no longer applies cleanly");
    expect(readFileSync(target, "utf8")).toBe("upstream changed\n");
  });

  it("tolerates changed context at a hunk edge without relaxing the edited lines", () => {
    const root = temporaryDir("e-pi-unified-fuzz-");
    const target = join(root, "sample.js");
    writeFileSync(target, "upstream context\nold\ntail\n", "utf8");

    applyUnifiedPatch(
      root,
      [
        "diff --git a/sample.js b/sample.js",
        "--- a/sample.js",
        "+++ b/sample.js",
        "@@ -1,3 +1,3 @@",
        " original context",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    );

    expect(readFileSync(target, "utf8")).toBe("upstream context\nnew\ntail\n");
  });
});

describe("applyPiCompatibilityPatches", () => {
  it("keeps Pi's stock transcript and status dock ownership while disabled", () => {
    const packageDir = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    const source = readFileSync(join(packageDir, "dist", "modes", "interactive", "chat-viewport.js"), "utf8");

    expect(source).toContain('process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true"');
    expect(source).toContain("const ePiDock = externalComposer");
    expect(source).toContain("fullscreenTranscriptContainer.addChild(new Spacer(4))");
    expect(source).toMatch(
      /component: options\.pendingMessages[^]*component: options\.status[^]*component: options\.widgetsAbove/,
    );
    expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    expect(preparePiPackageForMode(packageDir, true)).toBe(true);
  });

  it("applies both compatibility patches and is idempotent", () => {
    const packageDir = temporaryDir("e-pi-package-");
    const patchDir = temporaryDir("e-pi-patches-");
    const interactive = join(packageDir, "dist", "modes", "interactive");
    const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
    mkdirSync(interactive, { recursive: true });
    mkdirSync(join(tui, "components"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" }),
      "utf8",
    );
    writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");
    writeFileSync(join(interactive, "interactive-mode.js"), "const mode = 'stock';\n", "utf8");
    writeFileSync(join(tui, "components", "markdown.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "components", "scroll-view.js"), "class ScrollView {}\n", "utf8");
    writeFileSync(join(tui, "components", "text.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "layout.js"), "const scrollVirtualStart = 0;\n", "utf8");
    writeFileSync(join(tui, "tui-alt-screen.js"), "const prefix = '';\n", "utf8");
    writeFileSync(join(tui, "tui.js"), "let renderInvalidationRevision = 0;\n", "utf8");

    writeFileSync(
      join(patchDir, "pi-coding-agent.patch"),
      [
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,5 @@",
        " const mode = 'stock';",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+const fullscreenTranscriptContainer = externalComposer ? new Container() : this.documentContainer;",
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(patchDir, "pi-tui.patch"),
      [
        "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
        "--- a/dist/components/scroll-view.js",
        "+++ b/dist/components/scroll-view.js",
        "@@ -1 +1,2 @@",
        " class ScrollView {}",
        "+function renderVirtualViewport(width) { return width; }",
        "+// scrollToVirtualBlock(component) {}",
        "+// getVirtualBlockOffsets(components) {}",
        "diff --git a/dist/tui-alt-screen.js b/dist/tui-alt-screen.js",
        "--- a/dist/tui-alt-screen.js",
        "+++ b/dist/tui-alt-screen.js",
        "@@ -1 +1,2 @@",
        " const prefix = '';",
        "+const EPI_VIEWPORT_OSC_PREFIX = prefix;",
        "+const EPI_NAV_OSC_PREFIX = prefix;",
        "+function buildEPiNavOsc(primaryScrollView) { return primaryScrollView; }",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

    expect(preparePiPackageForMode(packageDir, true)).toBe(true);
    applyPiCompatibilityPatches(packageDir);

    expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    expect(hasPiCompatibilityPatch(packageDir)).toBe(true);
    expect(canLoadPiPackage(packageDir, true)).toBe(true);
    expect(canLoadPiPackage(packageDir, false)).toBe(true);
    expect(preparePiPackageForMode(packageDir, false)).toBe(true);
  });

  it("accepts stock Pi only while the optimization patch is disabled", () => {
    const packageDir = temporaryDir("e-pi-stock-package-");
    expect(hasPiCompatibilityPatch(packageDir)).toBe(false);
    expect(canLoadPiPackage(packageDir, false)).toBe(true);
    expect(canLoadPiPackage(packageDir, true)).toBe(false);
    expect(preparePiPackageForMode(packageDir, false)).toBe(true);
    expect(preparePiPackageForMode(packageDir, true)).toBe(false);
  });

  it("leaves the stock package untouched when either dependency patch conflicts", () => {
    const packageDir = temporaryDir("e-pi-package-conflict-");
    const patchDir = temporaryDir("e-pi-patches-conflict-");
    const interactive = join(packageDir, "dist", "modes", "interactive");
    const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
    mkdirSync(interactive, { recursive: true });
    mkdirSync(join(tui, "components"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" }),
      "utf8",
    );
    writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");

    const interactivePath = join(interactive, "interactive-mode.js");
    writeFileSync(interactivePath, "const mode = 'stock';\n", "utf8");
    writeFileSync(join(tui, "components", "scroll-view.js"), "upstream changed\n", "utf8");
    writeFileSync(
      join(patchDir, "pi-coding-agent.patch"),
      [
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,5 @@",
        " const mode = 'stock';",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+const fullscreenTranscriptContainer = externalComposer ? new Container() : this.documentContainer;",
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(patchDir, "pi-tui.patch"),
      [
        "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
        "--- a/dist/components/scroll-view.js",
        "+++ b/dist/components/scroll-view.js",
        "@@ -1 +1 @@",
        "-class ScrollView {}",
        "+function renderVirtualViewport(width) { return width; }",
        "+// scrollToVirtualBlock(component) {}",
        "+// getVirtualBlockOffsets(components) {}",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

    expect(() => applyPiCompatibilityPatches(packageDir)).toThrow("no longer applies cleanly");
    expect(readFileSync(interactivePath, "utf8")).toBe("const mode = 'stock';\n");
  });

  it("selects the 0.85 profile for any 0.85.x package", () => {
    const packageDir = temporaryDir("e-pi-package-085-");
    const patchDir = temporaryDir("e-pi-patches-085-");
    const interactive = join(packageDir, "dist", "modes", "interactive");
    const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
    mkdirSync(interactive, { recursive: true });
    mkdirSync(join(tui, "components"), { recursive: true });
    // A patch-level release rides the minor line's profile.
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" }),
      "utf8",
    );
    writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");
    writeFileSync(join(interactive, "chat-viewport.js"), "export function createChatViewport(options) {}\n", "utf8");
    writeFileSync(join(interactive, "interactive-mode.js"), "const mode = 'stock';\n", "utf8");
    writeFileSync(join(tui, "components", "markdown.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "components", "scroll-view.js"), "class ScrollView {}\n", "utf8");
    writeFileSync(join(tui, "components", "text.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "layout.js"), "const scrollVirtualStart = 0;\n", "utf8");
    writeFileSync(join(tui, "tui-alt-screen.js"), "const prefix = '';\n", "utf8");
    writeFileSync(join(tui, "tui.js"), "let renderInvalidationRevision = 0;\n", "utf8");

    writeFileSync(
      join(patchDir, "@earendil-works__pi-coding-agent@0.85.0.patch"),
      [
        "diff --git a/dist/modes/interactive/chat-viewport.js b/dist/modes/interactive/chat-viewport.js",
        "--- a/dist/modes/interactive/chat-viewport.js",
        "+++ b/dist/modes/interactive/chat-viewport.js",
        "@@ -1 +1,3 @@",
        " export function createChatViewport(options) {}",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,3 @@",
        " const mode = 'stock';",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(patchDir, "@earendil-works__pi-tui@0.85.0.patch"),
      [
        "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
        "--- a/dist/components/scroll-view.js",
        "+++ b/dist/components/scroll-view.js",
        "@@ -1 +1,2 @@",
        " class ScrollView {}",
        "+function renderVirtualViewport(width) { return width; }",
        "+// scrollToVirtualBlock(component) {}",
        "+// getVirtualBlockOffsets(components) {}",
        "diff --git a/dist/tui-alt-screen.js b/dist/tui-alt-screen.js",
        "--- a/dist/tui-alt-screen.js",
        "+++ b/dist/tui-alt-screen.js",
        "@@ -1 +1,2 @@",
        " const prefix = '';",
        "+const EPI_VIEWPORT_OSC_PREFIX = prefix;",
        "+const EPI_NAV_OSC_PREFIX = prefix;",
        "+function buildEPiNavOsc(primaryScrollView) { return primaryScrollView; }",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

    expect(preparePiPackageForMode(packageDir, true)).toBe(true);
    expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    expect(canLoadPiPackage(packageDir, true)).toBe(true);
  });

  it("rejects packages from a Pi line with no compatibility profile", () => {
    const packageDir = temporaryDir("e-pi-package-future-");
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }),
      "utf8",
    );

    expect(isPiCompatibilityApplied(packageDir)).toBe(false);
    expect(() => applyPiCompatibilityPatches(packageDir)).toThrow("No E-Pi TUI compatibility profile");
    expect(preparePiPackageForMode(packageDir, true)).toBe(false);
    expect(canLoadPiPackage(packageDir, false)).toBe(true);
  });

  // The newest known line may be inherited by the next minor, so a release that
  // only shifted line numbers keeps working with no code change. This is what
  // turns "every Pi release needs an E-Pi patch" into "only breaking releases
  // do". Inheritance is bounded to one minor, and the probes still gate it, so
  // it can never produce a half-patched package.
  describe("profile inheritance for an unrecognised line", () => {
    /** Newest `major.minor` declared in the source table, read from the file. */
    function newestProfileLine(): string {
      const source = readFileSync(join(process.cwd(), "electron/main/services/pi-compatibility-service.ts"), "utf8");
      return [...source.matchAll(/^ {2}"(\d+\.\d+)":/gm)]
        .map((m) => m[1])
        .sort((a, b) => {
          const [aMajor, aMinor] = a.split(".").map(Number);
          const [bMajor, bMinor] = b.split(".").map(Number);
          return aMajor - bMajor || aMinor - bMinor;
        })
        .pop()!;
    }

    /** A package at `version` whose real patch files are named for `newest`. */
    function fixtureFor(version: string, newest: string, dropMarker?: string): string {
      const source = readFileSync(join(process.cwd(), "electron/main/services/pi-compatibility-service.ts"), "utf8");
      const newestPatchVersion = new RegExp(`pi-coding-agent@(${newest.replace(".", "\\.")}\\.\\d+)\\.patch`).exec(
        source,
      )![1];
      const packageDir = temporaryDir(`e-pi-inherit-${version}-`);
      const patchDir = temporaryDir(`e-pi-inherit-patches-${version}-`);
      const interactive = join(packageDir, "dist", "modes", "interactive");
      const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
      mkdirSync(interactive, { recursive: true });
      mkdirSync(join(tui, "components"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
        "utf8",
      );
      writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");
      writeFileSync(join(interactive, "chat-viewport.js"), "export function createChatViewport(options) {}\n", "utf8");
      writeFileSync(join(interactive, "interactive-mode.js"), "const mode = 'stock';\n", "utf8");
      writeFileSync(
        join(tui, "components", "markdown.js"),
        "let renderInvalidationRevision = 0;\n// this.cachedTokens?.deref()\n",
        "utf8",
      );
      writeFileSync(join(tui, "components", "scroll-view.js"), "class ScrollView {}\n", "utf8");
      writeFileSync(
        join(tui, "components", "text.js"),
        "let renderInvalidationRevision = 0;\n// setPaddingX(paddingX)\n",
        "utf8",
      );
      writeFileSync(join(tui, "layout.js"), "const scrollVirtualStart = 0;\n", "utf8");
      writeFileSync(join(tui, "tui-alt-screen.js"), "const prefix = '';\n", "utf8");
      writeFileSync(join(tui, "tui.js"), "let renderInvalidationRevision = 0;\n", "utf8");

      const agentLines = [
        "diff --git a/dist/modes/interactive/chat-viewport.js b/dist/modes/interactive/chat-viewport.js",
        "--- a/dist/modes/interactive/chat-viewport.js",
        "+++ b/dist/modes/interactive/chat-viewport.js",
        "@@ -1 +1,4 @@",
        " export function createChatViewport(options) {}",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "+const ePiDock = externalComposer ? undefined : undefined;",
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,3 @@",
        " const mode = 'stock';",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
      ].filter((line) => line !== dropMarker);
      writeFileSync(
        join(patchDir, `@earendil-works__pi-coding-agent@${newestPatchVersion}.patch`),
        [...agentLines, ""].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(patchDir, `@earendil-works__pi-tui@${newestPatchVersion}.patch`),
        [
          "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
          "--- a/dist/components/scroll-view.js",
          "+++ b/dist/components/scroll-view.js",
          "@@ -1 +1,2 @@",
          " class ScrollView {}",
          "+function renderVirtualViewport(width) { return width; }",
          "+// scrollToVirtualBlock(component) {}",
          "+// getVirtualBlockOffsets(components) {}",
          "diff --git a/dist/tui-alt-screen.js b/dist/tui-alt-screen.js",
          "--- a/dist/tui-alt-screen.js",
          "+++ b/dist/tui-alt-screen.js",
          "@@ -1 +1,2 @@",
          " const prefix = '';",
          "+const EPI_VIEWPORT_OSC_PREFIX = prefix;",
          "+const EPI_NAV_OSC_PREFIX = prefix;",
          "+function buildEPiNavOsc(primaryScrollView) { return primaryScrollView; }",
          "+// event.lines ?? delta : delta",
          "",
        ].join("\n"),
        "utf8",
      );
      process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;
      return packageDir;
    }

    /** The line one minor above the newest known one. */
    function nextLine(newest: string, offset: number): string {
      const [major, minor] = newest.split(".").map(Number);
      return `${major}.${minor + offset}`;
    }

    it("inherits the newest profile for the next minor line", () => {
      const newest = newestProfileLine();
      const packageDir = fixtureFor(`${nextLine(newest, 1)}.7`, newest);
      expect(preparePiPackageForMode(packageDir, true)).toBe(true);
      expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    });

    it("refuses to inherit beyond one minor line", () => {
      const newest = newestProfileLine();
      const packageDir = fixtureFor(`${nextLine(newest, 2)}.0`, newest);
      expect(isPiCompatibilityApplied(packageDir)).toBe(false);
      expect(() => applyPiCompatibilityPatches(packageDir)).toThrow("No E-Pi TUI compatibility profile");
      expect(preparePiPackageForMode(packageDir, true)).toBe(false);
    });

    it("rolls back completely when an inherited profile fails its probes", () => {
      const newest = newestProfileLine();
      // The patch omits a marker the profile probes for, so the plan applies and
      // the post-write validation must reject it — the one path that genuinely
      // exercises rollback rather than failing before any write.
      const packageDir = fixtureFor(`${nextLine(newest, 1)}.7`, newest, "+component.ePiNavUserMessage = true;");
      const agentTarget = join(packageDir, "dist", "modes", "interactive", "chat-viewport.js");
      const tuiTarget = join(
        packageDir,
        "node_modules",
        "@earendil-works",
        "pi-tui",
        "dist",
        "components",
        "scroll-view.js",
      );
      const agentBefore = readFileSync(agentTarget, "utf8");
      const tuiBefore = readFileSync(tuiTarget, "utf8");

      expect(preparePiPackageForMode(packageDir, true)).toBe(false);
      expect(readFileSync(agentTarget, "utf8")).toBe(agentBefore);
      expect(readFileSync(tuiTarget, "utf8")).toBe(tuiBefore);
    });
  });

  // A patch-level release rides its minor line's profile: the fuzzy matcher
  // absorbs line drift, and a genuinely incompatible build fails the
  // transactional apply instead of writing. 0.86 and 0.87 share the separate
  // `ePiDock` shape, so both lines are exercised by the same fixture builder.
  describe.each([
    {
      line: "0.86",
      probeVersion: "0.86.3",
      agentPatch: "@earendil-works__pi-coding-agent@0.86.1.patch",
      tuiPatch: "@earendil-works__pi-tui@0.86.1.patch",
    },
    {
      line: "0.87",
      probeVersion: "0.87.3",
      agentPatch: "@earendil-works__pi-coding-agent@0.87.0.patch",
      tuiPatch: "@earendil-works__pi-tui@0.87.0.patch",
    },
  ])("$line compatibility profile", ({ line, probeVersion, agentPatch, tuiPatch }) => {
    it(`applies to any ${line}.x package`, () => {
      const packageDir = temporaryDir(`e-pi-package-${line.replace(".", "")}-`);
      const patchDir = temporaryDir(`e-pi-patches-${line.replace(".", "")}-`);
      const interactive = join(packageDir, "dist", "modes", "interactive");
      const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
      mkdirSync(interactive, { recursive: true });
      mkdirSync(join(tui, "components"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: probeVersion }),
        "utf8",
      );
      writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");
      writeFileSync(join(interactive, "chat-viewport.js"), "export function createChatViewport(options) {}\n", "utf8");
      writeFileSync(join(interactive, "interactive-mode.js"), "const mode = 'stock';\n", "utf8");
      writeFileSync(join(tui, "components", "markdown.js"), "let renderInvalidationRevision = 0;\n", "utf8");
      writeFileSync(join(tui, "components", "scroll-view.js"), "class ScrollView {}\n", "utf8");
      writeFileSync(join(tui, "components", "text.js"), "let renderInvalidationRevision = 0;\n", "utf8");
      writeFileSync(join(tui, "layout.js"), "const scrollVirtualStart = 0;\n", "utf8");
      writeFileSync(join(tui, "tui-alt-screen.js"), "const prefix = '';\n", "utf8");
      writeFileSync(join(tui, "tui.js"), "let renderInvalidationRevision = 0;\n", "utf8");

      writeFileSync(
        join(patchDir, agentPatch),
        [
          "diff --git a/dist/modes/interactive/chat-viewport.js b/dist/modes/interactive/chat-viewport.js",
          "--- a/dist/modes/interactive/chat-viewport.js",
          "+++ b/dist/modes/interactive/chat-viewport.js",
          "@@ -1 +1,4 @@",
          " export function createChatViewport(options) {}",
          '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
          "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
          "+const ePiDock = externalComposer ? undefined : undefined;",
          "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
          "--- a/dist/modes/interactive/interactive-mode.js",
          "+++ b/dist/modes/interactive/interactive-mode.js",
          "@@ -1 +1,3 @@",
          " const mode = 'stock';",
          "+component.ePiVirtualRenderVolatile = true;",
          "+component.ePiNavUserMessage = true;",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(patchDir, tuiPatch),
        [
          "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
          "--- a/dist/components/scroll-view.js",
          "+++ b/dist/components/scroll-view.js",
          "@@ -1 +1,2 @@",
          " class ScrollView {}",
          "+function renderVirtualViewport(width) { return width; }",
          "+// scrollToVirtualBlock(component) {}",
          "+// getVirtualBlockOffsets(components) {}",
          "diff --git a/dist/tui-alt-screen.js b/dist/tui-alt-screen.js",
          "--- a/dist/tui-alt-screen.js",
          "+++ b/dist/tui-alt-screen.js",
          "@@ -1 +1,2 @@",
          " const prefix = '';",
          "+const EPI_VIEWPORT_OSC_PREFIX = prefix;",
          "+const EPI_NAV_OSC_PREFIX = prefix;",
          "+function buildEPiNavOsc(primaryScrollView) { return primaryScrollView; }",
          "",
        ].join("\n"),
        "utf8",
      );
      process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

      expect(preparePiPackageForMode(packageDir, true)).toBe(true);
      expect(isPiCompatibilityApplied(packageDir)).toBe(true);
      expect(canLoadPiPackage(packageDir, true)).toBe(true);
      // The dock marker is part of the profile's probe set, so a patch that
      // omits it must not count as applied.
      expect(readFileSync(join(interactive, "chat-viewport.js"), "utf8")).toContain("const ePiDock = externalComposer");
    });
  });

  // Patches are generated against the exact dist files of one patch-level
  // release, so a synthetic stub cannot catch the drift that broke 0.85.1
  // (pi-tui replaced the wheel-scroll expression our hunk anchors on). These
  // cases apply the real patches to the real published tarballs.
  describe("published Pi packages", () => {
    // Every supported line, including the currently pinned 1.1.0 build.
    const cases = [
      { version: "0.84.2", tui: "0.84.2" },
      { version: "0.85.0", tui: "0.85.0" },
      { version: "0.85.1", tui: "0.85.1" },
      { version: "0.86.0", tui: "0.86.0" },
      { version: "0.86.1", tui: "0.86.1" },
      { version: "0.87.0", tui: "0.87.0" },
      // The release that reported "needs stock TUI" purely because the shipped
      // bundle was stale. Its dist is byte-identical to 0.87.0, so it must pass
      // on the 0.87 profile with no dedicated patch files.
      { version: "0.87.1", tui: "0.87.1" },
      { version: "0.99.0", tui: "0.99.0" },
      { version: "0.99.1", tui: "0.99.1" },
      { version: "0.99.2", tui: "0.99.2" },
      { version: "1.1.0", tui: "1.1.0" },
    ];
    const dirs = new Map<string, string>();
    let skipped = "";

    beforeAll(async () => {
      const { execFileSync } = await import("node:child_process");
      const cacheRoot = join(tmpdir(), "e-pi-pi-tarballs");
      mkdirSync(cacheRoot, { recursive: true });

      // Download every missing tarball first: the loop below is sync `tar` work.
      // Failures are collected per-case so an offline run skips instead of
      // failing the whole file.
      const wanted = cases.flatMap(({ version, tui }) => [
        { name: "pi-coding-agent", spec: version },
        { name: "pi-tui", spec: tui },
      ]);
      await Promise.all(
        wanted.map(async ({ name, spec }) => {
          const tarball = join(cacheRoot, `${name}-${spec}.tgz`);
          if (existsSync(tarball)) return;
          try {
            const url = `https://registry.npmjs.org/@earendil-works/${name}/-/${name}-${spec}.tgz`;
            const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`registry responded ${response.status}`);
            writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
          } catch (cause) {
            skipped += `${name}@${spec}: ${String(cause)} `;
          }
        }),
      );

      await Promise.all(
        cases.map(async ({ version, tui }) => {
          const root = temporaryDir(`e-pi-real-${version.replace(/\./g, "-")}-`, true);
          const packageDir = join(root, "pi-coding-agent");
          try {
            for (const [name, spec, dest] of [
              ["pi-coding-agent", version, packageDir],
              ["pi-tui", tui, join(root, "staged-tui")],
            ] as const) {
              const tarball = join(cacheRoot, `${name}-${spec}.tgz`);
              if (!existsSync(tarball)) throw new Error(`missing tarball ${name}@${spec}`);
              mkdirSync(dest, { recursive: true });
              execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
            }
            // Nest pi-tui the way npm/pnpm place it inside a standalone install.
            const nested = join(packageDir, "node_modules", "@earendil-works", "pi-tui");
            mkdirSync(dirname(nested), { recursive: true });
            renameSync(join(root, "staged-tui"), nested);
            dirs.set(version, packageDir);
          } catch (cause) {
            skipped += `${version}: ${String(cause)} `;
          }
        }),
      );
    }, 300_000);

    for (const { version } of cases) {
      it(`applies the real compatibility patches to published pi ${version}`, () => {
        const packageDir = dirs.get(version);
        if (!packageDir) {
          // Offline: skip instead of asserting a false pass.
          console.warn(`[pi-compat] skipping ${version} — ${skipped.trim()}`);
          return;
        }

        process.env.E_PI_COMPATIBILITY_PATCH_DIR = join(process.cwd(), "patches");
        const altScreenPath = join(
          packageDir,
          "node_modules",
          "@earendil-works",
          "pi-tui",
          "dist",
          "tui-alt-screen.js",
        );

        expect(isPiCompatibilityApplied(packageDir)).toBe(false);
        applyPiCompatibilityPatches(packageDir);
        expect(isPiCompatibilityApplied(packageDir)).toBe(true);

        const altScreen = readFileSync(altScreenPath, "utf8");
        // E-Pi's own additions are present.
        expect(altScreen).toContain("EPI_VIEWPORT_OSC_PREFIX");
        expect(altScreen).toContain("buildEPiNavOsc(primaryScrollView)");
        // …and upstream's wheel path survives: synthetic wheel events stay
        // exact (`event.lines`) while real wheel events keep the wheel-lines
        // accessor that version shipped. 0.84.2 and 0.85.0 read a field;
        // 0.85.1 renamed it to `getWheelScrollLines(button)` to add an Alt
        // multiplier, and the patch must follow the rename rather than revert it.
        const wheelLines =
          version === "0.85.0" || version === "0.84.2"
            ? "this.wheelScrollLines"
            : "this.getWheelScrollLines(event.button)";
        const wheelMarkers =
          version.startsWith("0.99.") || version.startsWith("1.")
            ? [
                "event.lines ?? delta : delta",
                "this.wheelScroll.next(wheelEvent.direction, performance.now())",
                "this.routeWheel(wheelEvent, wheelDelta)",
              ]
            : [`event.lines ?? event.direction * ${wheelLines}`];
        expect(wheelMarkers.filter((marker) => !altScreen.includes(marker))).toEqual([]);
        const markdown = readFileSync(
          join(packageDir, "node_modules/@earendil-works/pi-tui/dist/components/markdown.js"),
          "utf8",
        );
        expect(!version.startsWith("0.99.") || markdown.includes("this.cachedTokens?.source === normalizedText")).toBe(
          true,
        );
        const markdownMarkers = version === "1.1.0" ? ["this.cachedTokens?.deref()", "flattenLines(result)"] : [];
        expect(markdownMarkers.filter((marker) => !markdown.includes(marker))).toEqual([]);
        // 0.85.1 introduced the Alt-scroll multiplier; every later level keeps it.
        expect(altScreen.includes("ALT_WHEEL_SCROLL_MULTIPLIER")).toBe(version !== "0.85.0" && version !== "0.84.2");

        // The agent-side patch must gate every behavior on E_Pi's opt-in, and
        // must leave upstream's own dock entry list intact. 0.86.1 changed that
        // list (footer `minSize` 1 -> 0); anchoring on it as *removed* lines is
        // what broke the 0.85 patch. The 0.86 patch therefore keeps the list as
        // untouched context and inserts a replacement dock afterwards, while
        // the 0.85 patch (which predates that change) rewrites the list inline.
        // 0.84.2 has no `chat-viewport.js` at all — the same layout lives inline
        // in `interactive-mode.js` — so the file and marker differ per line.
        const chatViewportPath = join(packageDir, "dist", "modes", "interactive", "chat-viewport.js");
        const interactiveModePath = join(packageDir, "dist", "modes", "interactive", "interactive-mode.js");
        const readChatViewport = (): string =>
          existsSync(chatViewportPath) ? readFileSync(chatViewportPath, "utf8") : "";
        const hasChatViewport = existsSync(chatViewportPath);
        const chatViewportBefore = readChatViewport();
        const interactiveModeBefore = readFileSync(interactiveModePath, "utf8");

        const dockSource = hasChatViewport ? chatViewportBefore : interactiveModeBefore;
        const dockMarker = hasChatViewport
          ? version.startsWith("0.86") ||
            version.startsWith("0.87") ||
            version.startsWith("0.99") ||
            version.startsWith("1.")
            ? "const ePiDock = externalComposer"
            : "const dock = externalComposer"
          : "externalComposer ? new Container() : this.documentContainer";

        expect(dockSource).toContain('const externalComposer = process.env.E_PI === "true"');
        expect(dockSource).toContain("fullscreenTranscriptContainer.addChild(new Spacer(4))");
        expect(dockSource).toContain(dockMarker);

        // Upstream additions that shipped on the same files the patches edit must
        // survive. A fuzzy hunk that matched the wrong anchor would silently drop
        // them, which is worse than failing to apply — the build would boot with
        // upstream behavior quietly deleted. Asserted as a collected list so every
        // line is checked once and a failure names exactly what went missing.
        const upstreamMarkers =
          (
            {
              "0.87.0": [
                // The new crash-extension hint and boundary-compaction branch both
                // live in interactive-mode.js, where two E-Pi hunks also land.
                [interactiveModeBefore, "getCrashExtensionHint(error)"],
                [interactiveModeBefore, "entriesRenderedByBoundaryCompaction"],
                // The reworked scroll-to-end indicator lives in tui-alt-screen.js.
                [altScreen, "scrollToEndIndicator()"],
              ],
              "1.1.0": [
                [interactiveModeBefore, "this.programStatus.reset()"],
                [interactiveModeBefore, "this.renderer.resetTextSelection()"],
                [altScreen, "getScreenLines()"],
                [altScreen, "drawKittyImagesLast"],
                [altScreen, "imageCellsNeedRedraw"],
              ],
            } as Record<string, [string, string][]>
          )[version] ?? [];

        const lostUpstream = upstreamMarkers
          .filter(([source, marker]) => !source.includes(marker))
          .map(([, marker]) => marker);
        expect(lostUpstream).toEqual([]);

        // Idempotent: a second pass must not double-apply.
        expect(preparePiPackageForMode(packageDir, true)).toBe(true);
        expect(readFileSync(altScreenPath, "utf8")).toBe(altScreen);
        expect(readFileSync(interactiveModePath, "utf8")).toBe(interactiveModeBefore);
        expect(readChatViewport()).toBe(chatViewportBefore);
      });
    }

    it("keeps stock Pi's dock reachable in every patched build", () => {
      // The replacement dock is selected *only* inside `externalComposer`, so
      // the upstream entry list must survive in the patched source. A patch that
      // dropped it unconditionally would silently change stock Pi rendering —
      // the exact regression this guards against.
      //
      // Assertions are collected first and checked once at the end: a per-line
      // `expect` inside the branch would be skipped silently for any line the
      // loop failed to reach, which is the failure mode this test exists for.
      const checked: string[] = [];
      const failures: string[] = [];

      for (const { version } of cases) {
        const packageDir = dirs.get(version);
        if (!packageDir) continue;

        // 0.86 keeps upstream's own `dock` untouched and derives from it; 0.85
        // inlines both branches, so the stock list sits in the nullary arm; 0.84
        // inlines the layout in interactive-mode.js as a ternary fallback.
        const chatViewportPath = join(packageDir, "dist", "modes", "interactive", "chat-viewport.js");
        const hasChatViewport = existsSync(chatViewportPath);
        const source = hasChatViewport
          ? readFileSync(chatViewportPath, "utf8")
          : readFileSync(join(packageDir, "dist", "modes", "interactive", "interactive-mode.js"), "utf8");
        const pattern = hasChatViewport
          ? version.startsWith("0.86") ||
            version.startsWith("0.87") ||
            version.startsWith("0.99") ||
            version.startsWith("1.")
            ? /const ePiDock = externalComposer[\s\S]*?: dock;/
            : /const dock = externalComposer\s*\?[\s\S]*?: new VStack\(\[/
          : /const fullscreenTranscriptContainer = externalComposer \? new Container\(\) : this\.documentContainer;/;

        checked.push(version);
        if (!pattern.test(source)) failures.push(`${version}: upstream dock branch missing`);
        const separateDock =
          version.startsWith("0.86") ||
          version.startsWith("0.87") ||
          version.startsWith("0.99") ||
          version.startsWith("1.");
        if (hasChatViewport && separateDock && !source.includes("{ component: options.pendingMessages")) {
          failures.push(`${version}: upstream dock entry list not preserved as context`);
        }
      }

      // Every supported line must have been inspected.
      expect(checked).toEqual(cases.map((c) => c.version));
      expect(failures).toEqual([]);
    });
  });
});
