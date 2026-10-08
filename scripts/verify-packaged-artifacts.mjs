import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { verifyPiBuildEnvironment } from "./pi-build-guard.mjs";

/**
 * Fail the packaging step when the built bundles are stale or incomplete.
 *
 * Why this exists: E-Pi's compatibility layer lives in two places that are
 * copied into the app by *different* mechanisms — the profile table is compiled
 * into `out/main/index.js` by electron-vite, while the patch files are copied
 * verbatim by `extraResources`. Running `electron-builder` without a preceding
 * `electron-vite build` therefore ships a bundle whose profile table is older
 * than its patch set: the app then reports a version as "not compatible" even
 * though the patches for it are sitting right there in the bundle.
 *
 * That failure is indistinguishable from a genuine upstream incompatibility at
 * the UI level, so it must be caught here rather than diagnosed from a
 * screenshot. Two checks, both cheap and both previously real mistakes:
 *
 * 1. Every profile line named in the source must exist in the compiled bundle.
 * 2. Every patch file referenced by the source must be registered in `build.extraResources`, or it will not ship at all.
 */

const repoRoot = process.cwd();
const SERVICE_SOURCE = join(repoRoot, "electron", "main", "services", "pi-compatibility-service.ts");
const MAIN_BUNDLE = join(repoRoot, "out", "main", "index.js");
const PATCH_DIR = join(repoRoot, "patches");

/** `major.minor` keys of the COMPATIBILITY_PROFILES table. */
function profileLines(source) {
  const start = source.indexOf("const COMPATIBILITY_PROFILES");
  if (start < 0) return [];
  const body = source.slice(start);
  // Keys are the only `  "d.d":` entries at that indent inside the table.
  return [...body.matchAll(/^ {2}"(\d+\.\d+)":/gm)].map((match) => match[1]);
}

/** Patch file names the source mentions, e.g. `@earendil-works__pi-tui@0.87.0.patch`. */
function referencedPatches(source) {
  return [...new Set([...source.matchAll(/"(?<name>@[^"]+\.patch)"/g)].map((match) => match.groups.name))];
}

export default async function beforePack(context) {
  const problems = [];
  const pi = verifyPiBuildEnvironment(repoRoot);
  console.log(`[verify-pi] manifest, lockfile, patches and installed packages agree: ${pi.version}`);

  if (!existsSync(SERVICE_SOURCE)) {
    console.warn(`[verify-build] ${SERVICE_SOURCE} not found; skipping freshness checks`);
    return;
  }
  const source = readFileSync(SERVICE_SOURCE, "utf8");
  const sourceLines = profileLines(source);

  // 1. Compiled bundle must know every profile line the source declares.
  if (existsSync(MAIN_BUNDLE)) {
    const bundle = readFileSync(MAIN_BUNDLE, "utf8");
    const missing = sourceLines.filter((line) => !bundle.includes(`"${line}":`));
    if (missing.length > 0) {
      problems.push(
        `out/main/index.js is stale: it lacks profile line(s) ${missing.join(", ")} that the source declares. ` +
          `Run \`electron-vite build\` (or use \`npm run dist:mac\`, which does) before packaging.`,
      );
    }
  } else {
    problems.push("out/main/index.js is missing: run `electron-vite build` before packaging.");
  }

  // 2. Every referenced patch must actually ship.
  const registered = new Set(
    context.packager.config.extraResources
      ?.map((entry) => entry.from)
      .filter((from) => typeof from === "string" && from.startsWith("patches/"))
      .map((from) => from.slice("patches/".length)) ?? [],
  );
  const unshipped = referencedPatches(source).filter(
    (name) => !registered.has(name) && existsSync(join(PATCH_DIR, name)),
  );
  if (unshipped.length > 0) {
    problems.push(
      `patch(es) present in patches/ but not registered in build.extraResources, so they would not ship: ` +
        `${unshipped.join(", ")}`,
    );
  }

  // 3. Registered patches must exist, or electron-builder fails later with a
  //    less obvious message.
  const dangling = [...registered].filter((name) => !existsSync(join(PATCH_DIR, name)));
  if (dangling.length > 0) {
    problems.push(`build.extraResources references missing patch file(s): ${dangling.join(", ")}`);
  }

  if (problems.length > 0) {
    throw new Error(`[verify-build] refusing to package an inconsistent build:\n  - ${problems.join("\n  - ")}`);
  }

  const shipped = readdirSync(PATCH_DIR).filter((name) => name.endsWith(".patch")).length;
  console.log(
    `[verify-build] ok: ${sourceLines.length} profile line(s), ${registered.size} registered patch(es), ${shipped} on disk`,
  );
}
