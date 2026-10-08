import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { pinnedPiVersion, verifyPiPackageVersions } from "./pi-build-guard.mjs";

/**
 * Keep macOS notification identity stable across unsigned local builds.
 *
 * Electron-builder leaves the Electron binary's ad-hoc identifier as
 * "Electron" when mac.identity is null. Re-signing the completed app bundle
 * makes codesign derive the identifier from CFBundleIdentifier
 * (works.earendil.e-pi), matching installed E-Pi builds and allowing macOS to
 * attribute notifications to E-Pi rather than Electron.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = join(appPath, "Contents", "Resources");
  const expected = pinnedPiVersion(context.packager.projectDir);
  const pi = verifyPiPackageVersions(join(resources, "app.asar.unpacked", "node_modules"), expected);
  const actual = execFileSync(
    join(resources, "node", "bin", "node"),
    ["--import", join(resources, "e-pi-tui-preload.mjs"), join(pi.agentDir, "dist", "cli.js"), "--version"],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, E_PI: "true", E_PI_TUI_OPTIMIZATIONS: "true" },
    },
  ).trim();
  if (actual !== expected) throw new Error(`[verify-pi] Packaged CLI reports ${actual}; expected ${expected}.`);
  console.log(`[verify-pi] packaged Pi CLI, agent and TUI verified: ${actual}`);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}
