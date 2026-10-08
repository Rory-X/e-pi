import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type * as Tui from "@earendil-works/pi-tui";
import type * as Layout from "@earendil-works/pi-tui/dist/layout.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { applyPiCompatibilityPatches } from "../electron/main/services/pi-compatibility-service";

const VERSION = "1.1.0";
type ViewportOptions = {
  document: Tui.Container;
  pendingMessages: Tui.Container;
  status: Tui.Container;
  widgetsAbove: Tui.Container;
  widgetsBelow: Tui.Container;
  editor: Tui.Container;
  footer: Tui.Container;
};
type Fixture = {
  tui: typeof Tui;
  layout: typeof Layout;
  createChatViewport(options: ViewportOptions): { transcript: Tui.ScrollView; root: Tui.VStack };
};

let root: string;
let stock: Fixture;
let patched: Fixture;
const scrollViews: Tui.ScrollView[] = [];

async function loadFixture(agentDir: string): Promise<Fixture> {
  const tuiDir = join(agentDir, "node_modules", "@earendil-works", "pi-tui");
  const tui = await import(pathToFileURL(join(tuiDir, "dist/index.js")).href);
  const layout = await import(pathToFileURL(join(tuiDir, "dist/layout.js")).href);
  const viewport = await import(pathToFileURL(join(agentDir, "dist/modes/interactive/chat-viewport.js")).href);
  return { tui, layout, createChatViewport: viewport.createChatViewport };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "e-pi-upstream-coverage-"));
  const cache = join(tmpdir(), "e-pi-pi-tarballs");
  const agentDir = join(root, "stock");
  const tuiDir = join(agentDir, "node_modules", "@earendil-works", "pi-tui");
  await Promise.all(
    [
      ["pi-coding-agent", agentDir],
      ["pi-tui", tuiDir],
    ].map(async ([name, dir]) => {
      mkdirSync(cache, { recursive: true });
      mkdirSync(dir, { recursive: true });
      const archive = join(cache, `${name}-${VERSION}.tgz`);
      if (!existsSync(archive)) {
        const response = await fetch(`https://registry.npmjs.org/@earendil-works/${name}/-/${name}-${VERSION}.tgz`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`registry responded ${response.status}`);
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      }
      execFileSync("tar", ["-xzf", archive, "-C", dir, "--strip-components=1"]);
    }),
  );
  // Only the real TUI's dependencies are needed for these layout comparisons.
  const manifestPath = join(tuiDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--cache",
      join(tmpdir(), "e-pi-npm-cache"),
    ],
    {
      cwd: tuiDir,
      stdio: "pipe",
      timeout: 120_000,
    },
  );
  const patchedDir = join(root, "patched");
  cpSync(agentDir, patchedDir, { recursive: true });
  applyPiCompatibilityPatches(patchedDir);
  stock = await loadFixture(agentDir);
  patched = await loadFixture(patchedDir);
}, 180_000);

afterEach(() => {
  for (const scrollView of scrollViews.splice(0)) scrollView.invalidate();
  vi.unstubAllEnvs();
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeHistory(fixture: Fixture, count = 1000) {
  const document = new fixture.tui.Container();
  const calls = new Map<number, number>();
  const expected = (width: number) =>
    Array.from({ length: count }, (_, id) =>
      Array.from({ length: width < 64 ? 3 : 2 }, (_value, row) => `message-${id}:${row}`),
    ).flat();
  for (let id = 0; id < count; id++) {
    document.addChild({
      render(width: number) {
        calls.set(width, (calls.get(width) ?? 0) + 1);
        return Array.from({ length: width < 64 ? 3 : 2 }, (_, row) => `message-${id}:${row}`);
      },
      invalidate() {},
    });
  }
  const scrollView = new fixture.tui.ScrollView(document, { follow: "end", primary: true });
  scrollViews.push(scrollView);
  return { scrollView, calls, expected };
}

function screen(fixture: Fixture, component: Tui.Component, width = 48, height = 12): string[] {
  return fixture.layout
    .renderLayoutFrame(component, width, height, () => undefined)
    .lines.map((line: string) => fixture.tui.stripTerminalSequences(line).trimEnd());
}

describe("official Pi 1.1.0 coverage of E-Pi features", () => {
  it("still lays out all historical blocks on resize, so viewport virtualization remains necessary", () => {
    vi.stubEnv("E_PI", "true");
    vi.stubEnv("E_PI_TUI_OPTIMIZATIONS", "true");
    const official = makeHistory(stock);
    const optimized = makeHistory(patched);
    for (const width of [48, 96]) {
      const expected = official.expected(width).slice(-12);
      expect(screen(stock, official.scrollView, width)).toEqual(expected);
      expect(screen(patched, optimized.scrollView, width)).toEqual(expected);
      expect(official.calls.get(width)).toBe(1000);
      expect(optimized.calls.get(width)).toBeLessThan(30);
    }
    console.info("[pi-coverage] blocks rendered per resize", {
      stock: Object.fromEntries(official.calls),
      patched: Object.fromEntries(optimized.calls),
    });
  });

  it("retains the official dock when disabled and moves host information into the transcript when enabled", () => {
    vi.stubEnv("E_PI", "true");
    const build = (fixture: Fixture) => {
      const document = new fixture.tui.Container();
      for (let i = 0; i < 40; i++) document.addChild(new fixture.tui.Text(`history-${i}`, 0, 0));
      const text = (label: string) => {
        const container = new fixture.tui.Container();
        container.addChild(new fixture.tui.Text(label, 0, 0));
        return container;
      };
      const viewport = fixture.createChatViewport({
        document,
        pendingMessages: text("PENDING"),
        status: text("WORKING"),
        widgetsAbove: text("ABOVE"),
        widgetsBelow: text("BELOW"),
        editor: text("EDITOR"),
        footer: text("FOOTER"),
      });
      scrollViews.push(viewport.transcript);
      return viewport;
    };
    vi.stubEnv("E_PI_TUI_OPTIMIZATIONS", "false");
    expect(screen(patched, build(patched).root)).toEqual(screen(stock, build(stock).root));

    vi.stubEnv("E_PI_TUI_OPTIMIZATIONS", "true");
    const official = build(stock);
    const optimized = build(patched);
    screen(stock, official.root);
    screen(patched, optimized.root);
    official.transcript.scrollBy(-20);
    optimized.transcript.scrollBy(-20);
    const officialScreen = screen(stock, official.root);
    const optimizedScreen = screen(patched, optimized.root);
    expect(officialScreen).toContain("WORKING");
    expect(officialScreen).toContain("ABOVE");
    expect(optimizedScreen).not.toContain("WORKING");
    expect(optimizedScreen).not.toContain("ABOVE");
    expect(optimizedScreen.slice(-2)).toEqual(["EDITOR", "FOOTER"]);
  });

  it("invalidates virtual block caches through 1.1's new Text.setPaddingX API", () => {
    vi.stubEnv("E_PI_TUI_OPTIMIZATIONS", "true");
    const document = new patched.tui.Container();
    for (let i = 0; i < 40; i++) document.addChild(new patched.tui.Text(`history-${i}`, 0, 0));
    const text = new patched.tui.Text("abcdefghijklmnopqrstuvwxyz0123456789", 0, 0);
    document.addChild(text);
    const scrollView = new patched.tui.ScrollView(document, { follow: "end", primary: true });
    scrollViews.push(scrollView);
    const before = screen(patched, scrollView, 20, 8);
    text.setPaddingX(4);
    const expected = new patched.tui.Text("abcdefghijklmnopqrstuvwxyz0123456789", 4, 0)
      .render(20)
      .map((line: string) => line.trimEnd());
    const after = screen(patched, scrollView, 20, 8);
    expect(after).not.toEqual(before);
    expect(after.slice(-expected.length)).toEqual(expected);
  });

  it("preserves the official weak Markdown token cache and updates cached lines after a theme change", () => {
    vi.stubEnv("E_PI_TUI_OPTIMIZATIONS", "true");
    const paint = (tag: string) => (value: string) => `${tag}${value}`;
    const theme = (tag: string) => ({
      heading: paint(tag),
      link: paint(tag),
      linkUrl: paint(tag),
      code: paint(tag),
      codeBlock: paint(tag),
      codeBlockBorder: paint(tag),
      quote: paint(tag),
      quoteBorder: paint(tag),
      hr: paint(tag),
      listBullet: paint(tag),
      bold: paint(tag),
      italic: paint(tag),
      strikethrough: paint(tag),
      underline: paint(tag),
    });
    const activeTheme = theme("BEFORE:");
    const markdown = new patched.tui.Markdown("# Header", 0, 0, activeTheme);
    const document = new patched.tui.Container();
    for (let i = 0; i < 40; i++) document.addChild(new patched.tui.Text(`history-${i}`, 0, 0));
    document.addChild(markdown);
    const scrollView = new patched.tui.ScrollView(document, { follow: "end", primary: true });
    scrollViews.push(scrollView);
    expect(screen(patched, scrollView).some((line) => line.includes("BEFORE:"))).toBe(true);
    const cache = Reflect.get(markdown, "cachedTokens");
    expect(cache).toBeInstanceOf(WeakRef);
    const tokens = cache.deref();
    Object.assign(activeTheme, theme("AFTER:"));
    markdown.invalidate();
    const changed = screen(patched, scrollView);
    expect(changed.some((line) => line.includes("AFTER:"))).toBe(true);
    expect(changed.some((line) => line.includes("BEFORE:"))).toBe(false);
    expect(Reflect.get(markdown, "cachedTokens").deref()).toBe(tokens);
  });
});
