/**
 * Preload module for the sidecar Node that runs a pi session.
 *
 * Passed as `--import <this file>` before pi's own entry so the hooks are
 * registered before any pi module is resolved. It must call `register()`
 * itself: exporting `resolve`/`load` from a preloaded module is not enough
 * for Node to adopt them as loader hooks.
 *
 * Registration is deliberately unconditional so the cost of a session spawn
 * never depends on the flags; each injector then checks
 * `E_PI_TUI_OPTIMIZATIONS` at the point it would change behavior, and the
 * optimization can be toggled without restarting the process.
 */

import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

try {
  register(join(here, "e-pi-tui-hooks.mjs"), import.meta.url);
} catch (cause) {
  // A hook failure must never prevent pi from starting: the session would run
  // without E-Pi's optimizations instead of failing to open at all.
  process.emitWarning?.(`[e-pi] TUI hooks unavailable: ${cause?.message ?? cause}`);
}
