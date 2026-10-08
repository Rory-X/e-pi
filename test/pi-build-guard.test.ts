import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const AGENT = "@earendil-works/pi-coding-agent";
const TUI = "@earendil-works/pi-tui";
const EXPECTED = "1.1.0";
const guardUrl = pathToFileURL(join(process.cwd(), "scripts", "pi-build-guard.mjs")).href;

describe("Pi packaging version guard", () => {
  let root: string;
  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const writePackage = (modulesDir: string, name: string, version: string) => {
    const dir = join(modulesDir, name);
    writeJson(join(dir, "package.json"), { name, version, main: "dist/index.js" });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "");
  };
  const verify = () =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const {verifyPiBuildEnvironment}=await import(process.argv[1]); console.log(JSON.stringify(verifyPiBuildEnvironment(process.argv[2])));",
        guardUrl,
        root,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "epi-pi-build-guard-"));
    writeJson(join(root, "package.json"), {
      dependencies: { [AGENT]: EXPECTED },
      devDependencies: { [TUI]: EXPECTED },
    });
    const patches = Object.fromEntries(
      [AGENT, TUI].map((name) => [`${name}@${EXPECTED}`, `patches/${name.replace("/", "__")}@${EXPECTED}.patch`]),
    );
    writeJson(join(root, "pnpm-workspace.yaml"), { patchedDependencies: patches });
    for (const path of Object.values(patches)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "fixture patch");
    }
    writeJson(join(root, "pnpm-lock.yaml"), {
      importers: {
        ".": {
          dependencies: { [AGENT]: { specifier: EXPECTED, version: `${EXPECTED}(patch_hash=test)` } },
          devDependencies: { [TUI]: { specifier: EXPECTED, version: `${EXPECTED}(patch_hash=test)` } },
        },
      },
      patchedDependencies: Object.fromEntries(Object.entries(patches).map(([name, path]) => [name, { path }])),
    });
    writePackage(join(root, "node_modules"), AGENT, EXPECTED);
    writePackage(join(root, "node_modules"), TUI, EXPECTED);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts only matching manifest, lockfile, patches and installed package versions", () => {
    expect(JSON.parse(verify()).version).toBe(EXPECTED);
  });
  it("refuses an old installed agent even if package.json was updated", () => {
    writePackage(join(root, "node_modules"), AGENT, "0.84.2");
    expect(verify).toThrow(/expected 1\.1\.0, found 0\.84\.2/);
  });
  it("refuses an old nested TUI that shadows the correctly pinned root TUI", () => {
    writePackage(join(root, "node_modules", AGENT, "node_modules"), TUI, "0.99.1");
    expect(verify).toThrow(/resolves pi-tui 0\.99\.1/);
  });
  it("resolves a pnpm-symlinked agent's actual dependency instead of the root alias", () => {
    const physicalModules = join(root, "store", "agent", "node_modules");
    writePackage(physicalModules, AGENT, EXPECTED);
    writePackage(physicalModules, TUI, "0.99.1");
    const alias = join(root, "node_modules", AGENT);
    rmSync(alias, { recursive: true, force: true });
    symlinkSync(join(physicalModules, AGENT), alias, "dir");
    expect(verify).toThrow(/resolves pi-tui 0\.99\.1/);
  });
  it("refuses a stale lockfile", () => {
    const path = join(root, "pnpm-lock.yaml");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    lock.importers["."].dependencies[AGENT].version = "0.84.2";
    writeJson(path, lock);
    expect(verify).toThrow(/pnpm-lock\.yaml does not lock/);
  });
  it("refuses unpinned ranges and mismatched agent/TUI declarations", () => {
    writeJson(join(root, "package.json"), {
      dependencies: { [AGENT]: "^1.1.0" },
      devDependencies: { [TUI]: EXPECTED },
    });
    expect(verify).toThrow(/same exact version/);
  });
  it("refuses missing or mismatched patch registrations", () => {
    writeJson(join(root, "pnpm-workspace.yaml"), { patchedDependencies: {} });
    expect(verify).toThrow(/Missing registered compatibility patch/);
  });
});
