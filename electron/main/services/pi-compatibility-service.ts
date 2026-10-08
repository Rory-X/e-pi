import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

type UnifiedHunk = {
  oldStart: number;
  lines: string[];
};

type UnifiedFilePatch = {
  path: string;
  hunks: UnifiedHunk[];
};

type PlannedFileChange = {
  target: string;
  original: string;
  content: string;
};

const PI_TUI_PROBE_PREFIX = "node_modules/@earendil-works/pi-tui/";

/**
 * The pi-tui patch carries the same feature code on every supported Pi line,
 * so its probes are shared by all profiles.
 */
const TUI_PROBES = [
  ["node_modules/@earendil-works/pi-tui/dist/components/markdown.js", "renderInvalidationRevision"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "renderVirtualViewport(width"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "scrollToVirtualBlock(component)"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "getVirtualBlockOffsets(components)"],
  ["node_modules/@earendil-works/pi-tui/dist/components/text.js", "renderInvalidationRevision"],
  ["node_modules/@earendil-works/pi-tui/dist/layout.js", "scrollVirtualStart"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "EPI_VIEWPORT_OSC_PREFIX"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "EPI_NAV_OSC_PREFIX"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "buildEPiNavOsc(primaryScrollView)"],
  ["node_modules/@earendil-works/pi-tui/dist/tui.js", "renderInvalidationRevision"],
] as const;

type CompatibilityProfile = {
  /** Candidate patch file names for each dependency; first existing wins. */
  agentPatchNames: readonly string[];
  tuiPatchNames: readonly string[];
  /** Marker strings that must all be present once the profile is applied. */
  probes: readonly (readonly [string, string])[];
};

/**
 * Probes shared by every line that stores the fullscreen layout in
 * `chat-viewport.js` (0.85 and later; 0.84 keeps it inline in
 * `interactive-mode.js` and therefore needs its own list).
 *
 * The replacement dock itself sits in the profile's own probe list, because
 * its identifier differs between lines — 0.85 rewrites upstream's dock entry
 * list inline, while 0.86+ derive a separate `ePiDock` from it.
 */
const CHAT_VIEWPORT_PROBES = [
  ["dist/modes/interactive/chat-viewport.js", "E_PI_TUI_OPTIMIZATIONS"],
  ["dist/modes/interactive/chat-viewport.js", 'const externalComposer = process.env.E_PI === "true"'],
  ["dist/modes/interactive/chat-viewport.js", "fullscreenTranscriptContainer.addChild(new Spacer(4))"],
  ["dist/modes/interactive/interactive-mode.js", "component.ePiVirtualRenderVolatile = true"],
  ["dist/modes/interactive/interactive-mode.js", "component.ePiNavUserMessage = true"],
  ...TUI_PROBES,
] as const;

/** 0.86+ builds a separate replacement dock instead of rewriting upstream's. */
const SEPARATE_DOCK_PROBE = [["dist/modes/interactive/chat-viewport.js", "const ePiDock = externalComposer"]] as const;

/**
 * One profile per supported Pi minor line (`major.minor`). Each profile's
 * patches are unified diffs generated against that line's dist files; the
 * fuzzy hunk matcher tolerates patch-level drift within the line, and a line
 * whose hunks no longer match fails the transactional apply before anything
 * is written. Pi moved the fullscreen layout into `chat-viewport.js` in
 * 0.85, which is why the agent probes differ between lines.
 *
 * Adding a line is a two-file change: a patch per dependency, plus the profile
 * below. The 0.86 line needed only the agent patch — pi-tui's dist files are
 * byte-identical to 0.85.1 except `tui-alt-screen.js`, and even that hunk still
 * matched. Its patch is therefore generated from the 0.86.1 dist so the hunks
 * are byte-aligned rather than relying on fuzz.
 *
 * These patches now cover only what cannot be reached from a stable API
 * boundary — principally pi-tui's virtual scrolling, whose code is injected
 * *inside* `layout.js`'s unexported `layoutComponent` and ScrollView's
 * internals. Behavior that can be expressed by wrapping an exported method
 * lives in `resources/e-pi-tui-hooks.mjs` instead, which rewrites modules in
 * memory at load time and is therefore immune to upstream renames.
 *
 * Patch names are listed newest-first and are mutually exclusive: 0.85.1
 * rewrote the wheel-scroll expression the tui patch anchors on, so each
 * patch variant matches exactly one upstream build. The fuzzy matcher must
 * not be able to pick a patch from a different patch level, or it would
 * silently drop the upstream changes the newer patch was generated against.
 */
const COMPATIBILITY_PROFILES: Readonly<Record<string, CompatibilityProfile>> = {
  "0.84": {
    agentPatchNames: [
      "@earendil-works__pi-coding-agent@0.84.2.patch",
      "@earendil-works__pi-coding-agent@0.84.0.patch",
      "pi-coding-agent.patch",
    ],
    tuiPatchNames: ["@earendil-works__pi-tui@0.84.2.patch", "@earendil-works__pi-tui@0.84.0.patch", "pi-tui.patch"],
    probes: [
      ["dist/modes/interactive/interactive-mode.js", "E_PI_TUI_OPTIMIZATIONS"],
      ["dist/modes/interactive/interactive-mode.js", 'const externalComposer = process.env.E_PI === "true"'],
      ["dist/modes/interactive/interactive-mode.js", "externalComposer ? new Container() : this.documentContainer"],
      ["dist/modes/interactive/interactive-mode.js", "fullscreenTranscriptContainer.addChild(new Spacer(4))"],
      ["dist/modes/interactive/interactive-mode.js", "component.ePiVirtualRenderVolatile = true"],
      ["dist/modes/interactive/interactive-mode.js", "component.ePiNavUserMessage = true"],
      ...TUI_PROBES,
    ],
  },
  "0.85": {
    // The agent-side patch targets (`chat-viewport.js`, `interactive-mode.js`)
    // are byte-identical across 0.85.0 and 0.85.1, so one patch covers the
    // whole patch level — unlike pi-tui, where 0.85.1 rewrote a hunk anchor.
    agentPatchNames: ["@earendil-works__pi-coding-agent@0.85.0.patch", "pi-coding-agent.patch"],
    tuiPatchNames: ["@earendil-works__pi-tui@0.85.1.patch", "@earendil-works__pi-tui@0.85.0.patch", "pi-tui.patch"],
    probes: CHAT_VIEWPORT_PROBES,
  },
  "0.86": {
    // 0.86.1 changed one line in `chat-viewport.js` (the dock's footer entry
    // went from `minSize: 1` to `minSize: 0`). The 0.85 agent patch anchored on
    // that literal, so it stopped matching; the 0.86 patch keeps upstream's
    // dock entry list as untouched context and inserts a replacement dock
    // after it, which is what makes the same upstream line irrelevant here.
    // The patch also applies to 0.86.0: that release differs only in
    // `interactive-mode.js`, and the hunks there are context-anchored.
    agentPatchNames: ["@earendil-works__pi-coding-agent@0.86.1.patch", "pi-coding-agent.patch"],
    // pi-tui's dist is byte-identical between 0.85.1 and 0.86.1, so the 0.85.1
    // patch is a valid fallback if the 0.86.1 one is ever absent.
    tuiPatchNames: ["@earendil-works__pi-tui@0.86.1.patch", "@earendil-works__pi-tui@0.85.1.patch", "pi-tui.patch"],
    probes: [...CHAT_VIEWPORT_PROBES, ...SEPARATE_DOCK_PROBE],
  },
  "0.87": {
    // 0.87.0 added code to `interactive-mode.js` (a crash-extension hint and two
    // new stream branches) and reworked the scroll-to-end indicator in
    // pi-tui's `tui-alt-screen.js`. Neither touched anything E-Pi anchors on:
    // both patches apply, and the only difference from the 0.86.1 patches is
    // hunk line numbers. Patches are still regenerated per line so the hunks
    // are byte-aligned to this dist rather than relying on the fuzzy matcher.
    agentPatchNames: ["@earendil-works__pi-coding-agent@0.87.0.patch", "pi-coding-agent.patch"],
    tuiPatchNames: ["@earendil-works__pi-tui@0.87.0.patch", "@earendil-works__pi-tui@0.86.1.patch", "pi-tui.patch"],
    probes: [...CHAT_VIEWPORT_PROBES, ...SEPARATE_DOCK_PROBE],
  },
  "0.99": {
    // 0.99 keeps the transcript layout, but routeWheel now accepts a computed
    // delta from WheelScrollAccelerator. Use a dedicated patch that preserves
    // that accelerator and Markdown's new parsed-token cache.
    agentPatchNames: ["@earendil-works__pi-coding-agent@0.99.2.patch", "@earendil-works__pi-coding-agent@0.99.1.patch"],
    tuiPatchNames: ["@earendil-works__pi-tui@0.99.2.patch", "@earendil-works__pi-tui@0.99.1.patch"],
    probes: [
      ...CHAT_VIEWPORT_PROBES,
      ...SEPARATE_DOCK_PROBE,
      ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "event.lines ?? delta : delta"],
    ],
  },
  "1.1": {
    // Upstream keeps the same full-transcript layout. Preserve 1.1's weak
    // Markdown token cache, Text.setPaddingX and image redraw fixes while
    // adding the E-Pi virtual viewport and host composer/navigation contract.
    agentPatchNames: ["@earendil-works__pi-coding-agent@1.1.0.patch"],
    tuiPatchNames: ["@earendil-works__pi-tui@1.1.0.patch"],
    probes: [
      ...CHAT_VIEWPORT_PROBES,
      ...SEPARATE_DOCK_PROBE,
      ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "event.lines ?? delta : delta"],
      ["node_modules/@earendil-works/pi-tui/dist/components/markdown.js", "this.cachedTokens?.deref()"],
      ["node_modules/@earendil-works/pi-tui/dist/components/text.js", "setPaddingX(paddingX)"],
    ],
  },
};

const PATCH_PRESENCE_PROBES = [
  ["dist/modes/interactive/interactive-mode.js", "ePiVirtualRenderVolatile"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "renderVirtualViewport(width"],
] as const;

/** Npm updates nest pi-tui; pnpm/electron packaging may place it beside Pi. */
function resolvePiTuiDir(packageDir: string): string {
  const candidates = [
    join(packageDir, "node_modules", "@earendil-works", "pi-tui"),
    join(resolve(packageDir, ".."), "pi-tui"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error("Could not locate Pi's @earendil-works/pi-tui dependency.");
}

function compatibilityProbePath(packageDir: string, relativePath: string): string {
  if (relativePath.startsWith(PI_TUI_PROBE_PREFIX)) {
    return join(resolvePiTuiDir(packageDir), relativePath.slice(PI_TUI_PROBE_PREFIX.length));
  }
  return join(packageDir, relativePath);
}

function readPackageVersion(packageDir: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: unknown })
      .version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The package's `major.minor` line, e.g. "0.87", or undefined if unreadable. */
function versionLine(packageDir: string): string | undefined {
  const version = readPackageVersion(packageDir);
  return (version ? /^(\d+\.\d+)\./.exec(version)?.[1] : undefined) ?? undefined;
}

/** Order two `major.minor` lines numerically. */
function lineGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * How many minor lines above the newest known line may still inherit it.
 *
 * One covers the realistic cadence (a new minor, or a patch-level release that
 * shifted line numbers). Anything further is a genuine signal that upstream has
 * moved on and a human should look, so it is refused instead of silently
 * applying a patch written for older upstream text.
 */
const MAX_INHERITED_MINOR_GAP = 1;

/** Signed minor distance between two same-major lines, or undefined if majors differ. */
function minorGap(fromLine: string, toLine: string): number | undefined {
  const [fromMajor, fromMinor] = fromLine.split(".").map(Number);
  const [toMajor, toMinor] = toLine.split(".").map(Number);
  if (fromMajor !== toMajor) return undefined;
  return toMinor - fromMinor;
}

/**
 * The profile to use for a package.
 *
 * An exact `major.minor` match wins. When E-Pi has not been built against the
 * line yet, the newest known line may be inherited, so a release that only
 * shifted line numbers keeps working without a code change — the common case
 * by far, and the one that produced three consecutive false "needs stock TUI"
 * reports. Inheritance is bounded to one minor line and is never a promise:
 * the apply below is transactional and gated on the profile's probes, so a
 * release that really did move the internals E-Pi anchors on fails loudly and
 * leaves the package byte-for-byte unchanged.
 *
 * A line below every known profile is refused outright — falling forward would
 * apply patches written against newer upstream text.
 */
function compatibilityProfileFor(packageDir: string): CompatibilityProfile | undefined {
  const line = versionLine(packageDir);
  if (!line) return undefined;

  const exact = COMPATIBILITY_PROFILES[line];
  if (exact) return exact;

  const newest = Object.keys(COMPATIBILITY_PROFILES)
    .sort((a, b) => (lineGt(a, b) ? 1 : -1))
    .pop();
  if (!newest) return undefined;

  const gap = minorGap(newest, line);
  if (gap === undefined || gap < 0 || gap > MAX_INHERITED_MINOR_GAP) return undefined;
  return COMPATIBILITY_PROFILES[newest];
}

function parseUnifiedPatch(source: string): UnifiedFilePatch[] {
  const lines = source.split("\n");
  const files: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split("\t", 1)[0];
      if (rawPath === "/dev/null") throw new Error("Compatibility patches may not delete files.");
      current = { path: rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath, hunks: [] };
      files.push(current);
      continue;
    }
    if (!line.startsWith("@@ ")) continue;
    if (!current) throw new Error("Malformed compatibility patch: hunk has no target file.");

    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (!match) throw new Error(`Malformed compatibility patch hunk: ${line}`);
    const hunk: UnifiedHunk = { oldStart: Number(match[1]), lines: [] };
    current.hunks.push(hunk);
    index++;
    while (index < lines.length) {
      const hunkLine = lines[index];
      if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ")) {
        index--;
        break;
      }
      if (hunkLine.startsWith("\\ No newline at end of file")) {
        index++;
        continue;
      }
      if (hunkLine.startsWith(" ") || hunkLine.startsWith("+") || hunkLine.startsWith("-")) {
        hunk.lines.push(hunkLine);
        index++;
        continue;
      }
      index--;
      break;
    }
  }

  if (files.length === 0) throw new Error("Compatibility patch contains no files.");
  return files;
}

function linesMatch(lines: string[], start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((line, index) => lines[start + index] === line);
}

function locateLines(lines: string[], expected: string[], preferred: number): number {
  if (linesMatch(lines, preferred, expected)) return preferred;

  let closest = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= lines.length - expected.length; index++) {
    if (!linesMatch(lines, index, expected)) continue;
    const distance = Math.abs(index - preferred);
    if (distance < closestDistance) {
      closest = index;
      closestDistance = distance;
    }
  }
  return closest;
}

function locateHunk(
  lines: string[],
  hunk: UnifiedHunk,
  preferred: number,
): { position: number; before: string[]; after: string[] } | undefined {
  const leadingContext = hunk.lines.findIndex((line) => line[0] !== " ");
  const trailingContext = [...hunk.lines].reverse().findIndex((line) => line[0] !== " ");
  const maxLeadingFuzz = Math.min(3, leadingContext < 0 ? hunk.lines.length : leadingContext);
  const maxTrailingFuzz = Math.min(3, trailingContext < 0 ? hunk.lines.length : trailingContext);

  for (let totalFuzz = 0; totalFuzz <= maxLeadingFuzz + maxTrailingFuzz; totalFuzz++) {
    for (let leadingFuzz = 0; leadingFuzz <= Math.min(maxLeadingFuzz, totalFuzz); leadingFuzz++) {
      const trailingFuzz = totalFuzz - leadingFuzz;
      if (trailingFuzz > maxTrailingFuzz) continue;
      const end = hunk.lines.length - trailingFuzz;
      const candidate = hunk.lines.slice(leadingFuzz, end);
      const before = candidate.filter((line) => line[0] !== "+").map((line) => line.slice(1));
      const after = candidate.filter((line) => line[0] !== "-").map((line) => line.slice(1));
      // A context-only or fully trimmed hunk is not a safe anchor.
      if (before.length === 0 || candidate.every((line) => line[0] === " ")) continue;
      const position = locateLines(lines, before, preferred + leadingFuzz);
      if (position >= 0) return { position, before, after };
    }
  }
  return undefined;
}

function applyFilePatch(source: string, patch: UnifiedFilePatch): string {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) lines.pop();
  let offset = 0;

  for (const hunk of patch.hunks) {
    const preferred = Math.max(0, hunk.oldStart - 1 + offset);
    const located = locateHunk(lines, hunk, preferred);
    if (!located) {
      throw new Error(`Compatibility patch no longer applies cleanly to ${patch.path} near line ${hunk.oldStart}.`);
    }
    lines.splice(located.position, located.before.length, ...located.after);
    offset += located.after.length - located.before.length;
  }

  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function planUnifiedPatch(
  rootDir: string,
  patchSource: string,
  changes = new Map<string, PlannedFileChange>(),
): Map<string, PlannedFileChange> {
  const root = resolve(rootDir);
  for (const patch of parseUnifiedPatch(patchSource)) {
    const target = resolve(root, patch.path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Compatibility patch escapes its target directory: ${patch.path}`);
    }
    if (!existsSync(target)) throw new Error(`Compatibility patch target is missing: ${patch.path}`);

    const previous = changes.get(target);
    const original = previous?.original ?? readFileSync(target, "utf8");
    const source = previous?.content ?? original;
    changes.set(target, { target, original, content: applyFilePatch(source, patch) });
  }
  return changes;
}

function commitPlannedChanges(changes: Map<string, PlannedFileChange>, validate?: () => boolean): void {
  const written: PlannedFileChange[] = [];
  try {
    for (const change of changes.values()) {
      writeFileSync(change.target, change.content, "utf8");
      written.push(change);
    }
    if (validate && !validate()) throw new Error("Pi update did not pass E-Pi's TUI compatibility checks.");
  } catch (cause) {
    for (const change of written.reverse()) writeFileSync(change.target, change.original, "utf8");
    throw cause;
  }
}

/** Apply a standard unified diff without relying on a system `patch` binary. */
export function applyUnifiedPatch(rootDir: string, patchSource: string): void {
  commitPlannedChanges(planUnifiedPatch(rootDir, patchSource));
}

export function isPiCompatibilityApplied(packageDir: string): boolean {
  const profile = compatibilityProfileFor(packageDir);
  if (!profile) return false;
  return profile.probes.every(([relativePath, marker]) => {
    try {
      return readFileSync(compatibilityProbePath(packageDir, relativePath), "utf8").includes(marker);
    } catch {
      return false;
    }
  });
}

export function hasPiCompatibilityPatch(packageDir: string): boolean {
  return PATCH_PRESENCE_PROBES.some(([relativePath, marker]) => {
    try {
      return readFileSync(compatibilityProbePath(packageDir, relativePath), "utf8").includes(marker);
    } catch {
      return false;
    }
  });
}

/** Stock packages are valid while disabled; enabled mode requires the complete gated patch. */
export function canLoadPiPackage(packageDir: string, optimizationsEnabled: boolean): boolean {
  if (optimizationsEnabled) return isPiCompatibilityApplied(packageDir);
  return !hasPiCompatibilityPatch(packageDir) || isPiCompatibilityApplied(packageDir);
}

/**
 * Prepare a package selected by the runtime, including packages installed
 * outside E-Pi's update button. Enabled mode injects the compatibility layer
 * transactionally; disabled mode never writes and only accepts stock Pi or a
 * complete env-gated patch.
 */
export function preparePiPackageForMode(packageDir: string, optimizationsEnabled: boolean): boolean {
  if (!optimizationsEnabled) return canLoadPiPackage(packageDir, false);
  if (isPiCompatibilityApplied(packageDir)) return true;
  try {
    applyPiCompatibilityPatches(packageDir);
    return true;
  } catch {
    return false;
  }
}

function compatibilityPatchDir(): string {
  const override = process.env.E_PI_COMPATIBILITY_PATCH_DIR?.trim();
  if (override) return override;

  if (typeof process.resourcesPath === "string") {
    const packaged = join(process.resourcesPath, "pi-compatibility");
    if (existsSync(packaged)) return packaged;
  }
  return join(process.cwd(), "patches");
}

function resolvePatchFile(dir: string, names: readonly string[], packageDir: string): string {
  // Patch variants within a minor line are mutually exclusive: each is
  // generated against one patch-level dist, and its hunks carry the upstream
  // text of that exact build. So the choice is made by the installed version,
  // never by which file happens to exist — otherwise a co-installed 0.85.1
  // patch would be applied to a 0.85.0 package, and the fuzzy matcher would
  // silently drop the upstream line it was generated against.
  const version = readPackageVersion(packageDir);
  if (version) {
    for (const name of names) {
      // Names carry the exact level they were generated for.
      const level = /@(\d+\.\d+\.\d+)\.patch$/.exec(name)?.[1];
      if (level === version && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing E-Pi compatibility patch (${names.join(" or ")}).`);
}

/**
 * Reapply E-Pi's TUI contract to a freshly downloaded Pi package. The update
 * service calls this while the package is still staged, so any upstream
 * conflict aborts before the live installation is replaced.
 */
export function applyPiCompatibilityPatches(packageDir: string): void {
  if (isPiCompatibilityApplied(packageDir)) return;

  const profile = compatibilityProfileFor(packageDir);
  if (!profile) {
    throw new Error(`No E-Pi TUI compatibility profile for Pi ${readPackageVersion(packageDir) ?? "unknown version"}.`);
  }

  const patchDir = compatibilityPatchDir();
  const changes = new Map<string, PlannedFileChange>();
  planUnifiedPatch(
    packageDir,
    readFileSync(resolvePatchFile(patchDir, profile.agentPatchNames, packageDir), "utf8"),
    changes,
  );
  const tuiDir = resolvePiTuiDir(packageDir);
  planUnifiedPatch(tuiDir, readFileSync(resolvePatchFile(patchDir, profile.tuiPatchNames, tuiDir), "utf8"), changes);

  // Plan both dependency patches before touching disk. If either patch no
  // longer matches a newer Pi release, enabling the optimization leaves the
  // currently installed stock package byte-for-byte unchanged.
  commitPlannedChanges(changes, () => isPiCompatibilityApplied(packageDir));
}
