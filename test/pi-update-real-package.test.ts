import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end update against the _real_ published package.
 *
 * This is the regression test for the failure that made E-Pi refuse an update:
 * a new Pi line changed code inside a file the previous line's patch anchored
 * on, the transactional apply failed, and the user was asked to fall back to
 * stock pi-tui. A synthetic tarball cannot catch that, so this drives the real
 * `applyPiUpdate` over real registry tarballs.
 *
 * The target is derived from the patches that actually ship, so adding a new
 * supported line keeps this test honest without anyone remembering to bump a
 * constant — and an update to the newest supported line must never fall back.
 *
 * Network and `npm install` are required; when either is unavailable the case
 * skips instead of asserting a false pass.
 */

/** Every agent patch that ships, newest last — i.e. every supported line. */
const AGENT_PATCH_PREFIX = "@earendil-works__pi-coding-agent@";
const shippedVersions = readdirSync(join(process.cwd(), "patches"))
  .filter((name) => name.startsWith(AGENT_PATCH_PREFIX) && name.endsWith(".patch"))
  .map((name) => name.slice(AGENT_PATCH_PREFIX.length, -".patch".length))
  .sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  });

const TARGET = shippedVersions[shippedVersions.length - 1]!;
/** The line a user would be upgrading from. */
const FROM = shippedVersions[shippedVersions.length - 2]!;

const cacheRoot = join(tmpdir(), "e-pi-update-real-cache");
const packageRoot = mkdtempSync(join(tmpdir(), "e-pi-update-real-"));
const installedDir = join(packageRoot, "pi-coding-agent");

process.env.PI_PACKAGE_DIR = installedDir;
// Keep the staged `npm install` off the host's possibly root-owned cache.
process.env.npm_config_cache = join(tmpdir(), "e-pi-npm-cache");

vi.mock("electron", () => ({
  net: {
    fetch: vi.fn(async (url: string) => {
      if (url.includes("/latest")) {
        return { ok: true, json: async () => ({ version: TARGET }) } as Response;
      }
      if (url.endsWith(`${TARGET}.tgz`)) {
        const tarball = join(cacheRoot, `pi-coding-agent-${TARGET}.tgz`);
        if (!existsSync(tarball)) throw new Error("tarball not staged");
        const data = readFileSync(tarball);
        return {
          ok: true,
          arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }),
  },
}));

import { applyPiUpdate, resetPiUpdateCacheForTests } from "../electron/main/services/pi-update-service";

let skipReason = "";

beforeAll(async () => {
  mkdirSync(cacheRoot, { recursive: true });
  const tarball = join(cacheRoot, `pi-coding-agent-${TARGET}.tgz`);
  if (existsSync(tarball)) return;
  try {
    const url = `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${TARGET}.tgz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`registry responded ${response.status}`);
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  } catch (cause) {
    skipReason = String(cause);
  }
}, 300_000);

afterAll(() => {
  rmSync(packageRoot, { recursive: true, force: true });
  delete process.env.PI_PACKAGE_DIR;
  delete process.env.npm_config_cache;
});

describe(`real update to the newest supported package (${TARGET})`, () => {
  it("patches and swaps in the real package instead of asking for a stock fallback", async () => {
    if (skipReason) {
      console.warn(`[pi-update-real] skipping ${TARGET} — ${skipReason}`);
      return;
    }

    resetPiUpdateCacheForTests();
    // The install a user on the previous supported line would have.
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: FROM, type: "module" }, null, 2),
    );

    const result = await applyPiUpdate({ tuiOptimizationsEnabled: true });

    // The whole point: no fallback prompt, the optimization patch survived.
    expect(result).toMatchObject({ from: FROM, to: TARGET, fallbackToStock: false });

    const chatViewport = readFileSync(join(installedDir, "dist", "modes", "interactive", "chat-viewport.js"), "utf8");
    const altScreen = readFileSync(
      join(installedDir, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-alt-screen.js"),
      "utf8",
    );
    expect(chatViewport).toContain("const ePiDock = externalComposer");
    expect(altScreen).toContain("EPI_VIEWPORT_OSC_PREFIX");

    // The runtime spawns this entry, so a swap that dropped it would brick sessions.
    expect(existsSync(join(installedDir, "dist", "cli.js"))).toBe(true);
    // No staging or backup directories left behind.
    const leftovers = readdirSync(packageRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name.includes(".old-") || name.includes(".e-pi-update-"));
    expect(leftovers).toEqual([]);
  }, 900_000);
});
