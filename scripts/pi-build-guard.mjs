import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { parse } from "yaml";

const AGENT = "@earendil-works/pi-coding-agent";
const TUI = "@earendil-works/pi-tui";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function pinnedPiVersion(projectDir) {
  const manifest = readJson(join(projectDir, "package.json"));
  const version = manifest.dependencies?.[AGENT];
  const tuiVersion = manifest.devDependencies?.[TUI] ?? manifest.dependencies?.[TUI];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || tuiVersion !== version) {
    throw new Error("[verify-pi] Pi agent and pi-tui must be pinned to the same exact version in package.json.");
  }
  return version;
}

/** Resolving from the agent also catches an old nested TUI shadowing the root copy. */
export function verifyPiPackageVersions(nodeModulesDir, expected) {
  const agentDir = join(nodeModulesDir, AGENT);
  const agentManifest = join(agentDir, "package.json");
  for (const name of [AGENT, TUI]) {
    const actual = readJson(join(nodeModulesDir, name, "package.json")).version;
    if (actual !== expected) throw new Error(`[verify-pi] ${name}: expected ${expected}, found ${actual}.`);
  }
  const agentRequire = createRequire(realpathSync(agentManifest));
  let tuiDir = dirname(agentRequire.resolve(TUI));
  while (!existsSync(join(tuiDir, "package.json"))) {
    const parent = dirname(tuiDir);
    if (parent === tuiDir) throw new Error("[verify-pi] Cannot locate the agent's resolved pi-tui package.");
    tuiDir = parent;
  }
  const resolved = readJson(join(tuiDir, "package.json"));
  if (resolved.name !== TUI || resolved.version !== expected) {
    throw new Error(`[verify-pi] Agent resolves pi-tui ${resolved.version}; expected ${expected}: ${tuiDir}`);
  }
  return { version: expected, agentDir, tuiDir };
}

export function verifyPiBuildEnvironment(projectDir) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error("[verify-pi] Build with Node.js 22.19+; the bundled resources/node/bin/node is suitable.");
  }
  const expected = pinnedPiVersion(projectDir);
  const lock = parse(readFileSync(join(projectDir, "pnpm-lock.yaml"), "utf8"));
  const workspace = parse(readFileSync(join(projectDir, "pnpm-workspace.yaml"), "utf8"));
  for (const [name, scope] of [
    [AGENT, "dependencies"],
    [TUI, "devDependencies"],
  ]) {
    const record = lock.importers?.["."]?.[scope]?.[name];
    if (record?.specifier !== expected || record.version?.split("(")[0] !== expected) {
      throw new Error(`[verify-pi] pnpm-lock.yaml does not lock ${name} to ${expected}. Run pnpm install.`);
    }
    const patch = workspace.patchedDependencies?.[`${name}@${expected}`];
    if (typeof patch !== "string" || !existsSync(join(projectDir, patch))) {
      throw new Error(`[verify-pi] Missing registered compatibility patch for ${name}@${expected}.`);
    }
    if (lock.patchedDependencies?.[`${name}@${expected}`]?.path !== patch) {
      throw new Error(`[verify-pi] pnpm-lock.yaml uses a different compatibility patch for ${name}@${expected}.`);
    }
  }
  return verifyPiPackageVersions(join(projectDir, "node_modules"), expected);
}
