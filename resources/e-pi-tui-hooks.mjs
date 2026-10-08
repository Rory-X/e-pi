/**
 * E-Pi's runtime compatibility layer for pi's TUI.
 *
 * Loaded by the sidecar Node through `--import` (see `e-pi-tui-preload.mjs`)
 * and registered as ESM loader hooks. For each pi module that E-Pi needs to
 * change, this file appends a small self-contained injector to the module's
 * source **in memory** — the file on disk is never modified.
 *
 * Why this exists instead of text patches:
 *
 * A unified diff has to encode upstream's exact expressions, so any upstream
 * rename breaks it. Pi 0.85.1 renamed `wheelScrollLines` to
 * `getWheelScrollLines(button)` and our patch stopped applying, even though
 * upstream's *behavior* was unchanged. The injectors below instead wrap
 * stable API boundaries (methods on exported classes) and express intent in
 * terms of our own protocol. They never mention upstream's expressions, so
 * upstream is free to rename or restructure them.
 *
 * Mechanics that matter:
 *
 * - The injected code is appended to the _target module's_ source, so it runs inside that module's scope and can see its
 *   internal bindings (`getScrollViewsAt`, module-level constants, …).
 * - Injectors are serialized to strings, so they must be self-contained: they may not close over anything defined in this
 *   file. Every value they need is embedded via `JSON.stringify`.
 * - Registration runs on Node's hooks thread; the injectors themselves run in the module thread.
 */

/**
 * Terminal protocol constants.
 *
 * ESC (\`\u001b\`) is written as a Unicode escape rather than a literal control
 * character so the source stays diffable and lint-clean; every consumer sees
 * the same bytes.
 */
const ESC = "\u001b";
const ST = `${ESC}\\`;
/** Regex-safe copy: ST ends with a backslash, which would escape a following `$`. */
const ST_ANCHORED = `(?:${ESC}\\\\)`;

/** Pattern for E-Pi's synthetic wheel escape: exact rows + coordinates. */
export const WHEEL_PATTERN = new RegExp(
  `^${ESC}_e-pi:viewport:wheel:v1;(-?[1-9]\\d{0,3});(0|[1-9]\\d{0,4});(0|[1-9]\\d{0,4})${ST_ANCHORED}$`,
);
/** Pattern for "scroll transcript row N to the viewport top". */
export const SCROLL_TO_ROW_PATTERN = new RegExp(`^${ESC}_e-pi:viewport:scrollto:v1;([1-9]\\d{0,6})${ST_ANCHORED}$`);
export const SCROLL_TO_BOTTOM_INPUT = `${ESC}_e-pi:viewport:bottom${ST}`;
export const VIEWPORT_INPUT_PREFIX = `${ESC}_e-pi:viewport:`;
/** Out-of-band channel carrying the primary scroll view's position each frame. */
export const VIEWPORT_OSC_PREFIX = `${ESC}]6973;e-pi:viewport:v1;`;
/** Out-of-band channel carrying the session navigator's rail entries. */
export const NAV_OSC_PREFIX = `${ESC}]6974;e-pi:nav:v1;`;
/** End of upstream's synchronized-output frame; our OSC must land inside it. */
export const END_SYNCHRONIZED = `${ESC}[?2026l`;
/**
 * Control characters and payload separators are stripped from navigator labels
 * and replies: they contain model output, and an unescaped ESC there could
 * forge its own escape sequence in the host's terminal.
 */
// Protocol payloads must strip terminal control bytes before OSC emission.
// eslint-disable-next-line no-control-regex
export const UNSAFE_LABEL = /[\u0000-\u001f\u007f;,|]/g;
export const LABEL_MAX = 80;
export const REPLY_MAX = 160;

/**
 * Injector for `tui-alt-screen.js`.
 *
 * Replaces these text-patch hunks:
 * - the E-Pi private-escape branch inside `handleViewportInput`
 * - `let remaining = event.lines ?? event.direction * this.…`
 *
 * Both are reached by wrapping stable prototype methods, so upstream can
 * rename the wheel-lines member without breaking us.
 */
function altScreenInjector() {
  return `
(() => {
  const enabled = () => process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";
  if (typeof TuiAltScreen === "undefined") return;
  const P = TuiAltScreen.prototype;
  if (P.__ePiInjected) return;
  P.__ePiInjected = true;

  const wheelRe = new RegExp(${JSON.stringify(WHEEL_PATTERN.source)});
  const rowRe = new RegExp(${JSON.stringify(SCROLL_TO_ROW_PATTERN.source)});
  const toBottom = ${JSON.stringify(SCROLL_TO_BOTTOM_INPUT)};
  const inputPrefix = ${JSON.stringify(VIEWPORT_INPUT_PREFIX)};
  const viewportOsc = ${JSON.stringify(VIEWPORT_OSC_PREFIX)};
  const navOsc = ${JSON.stringify(NAV_OSC_PREFIX)};
  // Upstream's end-of-frame marker. Matched textually because it is a protocol
  // constant rather than an implementation detail: terminals key off the exact
  // bytes, so it cannot be renamed the way a member can.
  const endSync = "\\x1b[?2026l";
  // Embedded rather than referenced: injectors are stringified, so nothing from
  // this file's scope is visible to them.
  const unsafeLabel = new RegExp(${JSON.stringify(UNSAFE_LABEL.source)}, "g");
  const labelMax = ${JSON.stringify(LABEL_MAX)};
  const replyMax = ${JSON.stringify(REPLY_MAX)};

  // E-Pi's private input protocol. Handled before upstream so our escapes are
  // never interpreted as terminal input, and swallowed unrecognized ones so a
  // newer host talking to an older pi degrades quietly.
  const upstreamViewportInput = P.handleViewportInput;
  P.handleViewportInput = function (data) {
    if (!enabled() || typeof data !== "string") return upstreamViewportInput.call(this, data);

    const row = rowRe.exec(data);
    if (row) {
      const index = Number.parseInt(row[1], 10) - 1;
      const scrollView = this.currentLayout && this.currentLayout.primaryScrollView
        ? this.currentLayout.primaryScrollView
        : this.implicitScrollView;
      const target = this.ePiNavBlocks ? this.ePiNavBlocks[index] : undefined;
      if (target && scrollView && typeof scrollView.scrollToVirtualBlock === "function") {
        if (scrollView.scrollToVirtualBlock(target) && typeof this.requestRender === "function") {
          this.requestRender();
        }
      }
      return { consume: true };
    }

    const wheel = wheelRe.exec(data);
    if (wheel) {
      this.routeWheel({
        direction: 0,
        lines: Number.parseInt(wheel[1], 10),
        x: Number.parseInt(wheel[2], 10),
        y: Number.parseInt(wheel[3], 10),
      });
      return { consume: true };
    }

    if (data === toBottom) {
      if (typeof this.scrollToBottom === "function") this.scrollToBottom();
      return { consume: true };
    }

    if (data.startsWith(inputPrefix)) return { consume: true };
    return upstreamViewportInput.call(this, data);
  };

  // Synthetic wheel events carry exact rows. Rather than re-implementing
  // upstream's scroll distribution (which would silently go stale), reuse it:
  // force "one row per unit" and pass the row count as the direction. Upstream
  // multiplies direction by its wheel-lines accessor, whichever name that has
  // this release, and distributes the result to the scroll views under the
  // cursor exactly as it would for a real wheel event.
  const upstreamRouteWheel = P.routeWheel;
  P.routeWheel = function (event, ...args) {
    if (!enabled() || !event || typeof event.lines !== "number") {
      return upstreamRouteWheel.call(this, event, ...args);
    }
    // 0.99 computes acceleration before routing and passes the resulting delta
    // as a second argument. Our host has already computed exact rows, so pass
    // them directly without changing the accelerator's gesture state.
    if (upstreamRouteWheel.length >= 2) {
      return upstreamRouteWheel.call(this, event, event.lines);
    }
    // Temporarily make "one wheel unit == one row", then hand upstream our row
    // count as the direction: it multiplies by whatever wheel-lines accessor
    // this release provides (a field on 0.84, a method on 0.85.1+) and yields
    // exactly \`lines\` rows. Restoring by \`delete\` keeps the prototype lookup
    // intact instead of leaving an own property behind.
    const savedLines = this.wheelScrollLines;
    const hadAccessor = typeof this.getWheelScrollLines === "function";
    const accessorDescriptor = Object.getOwnPropertyDescriptor(this, "getWheelScrollLines");
    this.wheelScrollLines = 1;
    if (hadAccessor) this.getWheelScrollLines = () => 1;
    try {
      return upstreamRouteWheel.call(this, { ...event, direction: event.lines });
    } finally {
      this.wheelScrollLines = savedLines;
      if (hadAccessor) {
        if (accessorDescriptor) Object.defineProperty(this, "getWheelScrollLines", accessorDescriptor);
        else delete this.getWheelScrollLines;
      }
    }
  };

  // Replaces the \`END_SYNCHRONIZED_OUTPUT\` hunk. Upstream builds the frame in
  // a local \`buffer\` and writes it at the end of \`doRender\`, so the only way
  // to append to that buffer is to take over the write. We let upstream run
  // with a capturing \`terminal.write\`, then emit the captured bytes followed
  // by our out-of-band sequences inside a single synchronized frame.
  const upstreamDoRender = P.doRender;
  P.doRender = function (...args) {
    // Shipped text patches already emit both OSC channels in the frame. Let
    // them own emission so the hook does not duplicate the viewport payload.
    if (!enabled() || !this.terminal || typeof this.buildEPiNavOsc === "function") {
      return upstreamDoRender.apply(this, args);
    }

    const upstreamWrite = this.terminal.write;
    let captured = "";
    let capturing = true;
    this.terminal.write = (chunk) => {
      if (capturing && typeof chunk === "string") {
        captured += chunk;
        return true;
      }
      return upstreamWrite.call(this.terminal, chunk);
    };
    try {
      upstreamDoRender.apply(this, args);
    } finally {
      capturing = false;
      this.terminal.write = upstreamWrite;
    }
    if (captured === "") return;

    const primary = (this.currentLayout && this.currentLayout.primaryScrollView) || this.implicitScrollView;
    let out = captured;
    if (primary) {
      const maxScrollTop = Math.max(0, (primary.contentHeight ?? 0) - (primary.viewportHeight ?? 0));
      const following = primary.isFollowingEnd ? 1 : 0;
      const sequences =
        viewportOsc + (primary.scrollTop ?? 0) + ";" + maxScrollTop + ";" + following + "\\x07" + buildNavOsc(this, primary);
      // Inside the synchronized frame, not after it: END_SYNCHRONIZED_OUTPUT
      // closes the atomic region, so appending past it would let the terminal
      // paint the frame and our sequences separately. When the marker is
      // absent, fall back to appending so the data is still emitted.
      if (sequences !== "" && out.includes(endSync)) {
        out = out.replace(endSync, sequences + endSync);
      } else {
        out += sequences;
      }
    }
    upstreamWrite.call(this.terminal, out);
  };

  /**
   * Session-navigator rail payload: one "row,label|reply" entry per user
   * message, so the host can draw a clickable rail. Emitted only on change.
   */
  function buildNavOsc(alt, primaryScrollView) {
    const blocks = alt.ePiNavBlocks;
    const labels = alt.ePiNavLabels;
    if (!blocks || !labels || blocks.length === 0) return "";

    let offsets = typeof primaryScrollView.getVirtualBlockOffsets === "function"
      ? primaryScrollView.getVirtualBlockOffsets(blocks)
      : undefined;
    // Fall back to walking the render cache when no virtual layout exists yet.
    if ((!offsets || offsets.size !== blocks.length) && typeof primaryScrollView.getAllBlocks === "function" && primaryScrollView.ePiLastContext) {
      const flat = primaryScrollView.getAllBlocks();
      const context = primaryScrollView.ePiLastContext;
      const contentWidth = typeof primaryScrollView.getContentWidth === "function"
        ? primaryScrollView.getContentWidth(context.viewport.width)
        : context.viewport.width;
      offsets = new Map();
      let cursor = 0;
      for (const block of flat) {
        if (blocks.indexOf(block) >= 0) offsets.set(block, cursor);
        const cached = context.renderCache.get(block);
        const lines = cached && cached.get(Math.max(1, Math.floor(contentWidth)));
        cursor += lines ? lines.length : 1;
      }
    }
    if (!offsets || offsets.size !== blocks.length) return "";

    const replies = alt.ePiNavReplies || [];
    const parts = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const row = offsets.get(blocks[i]);
      const label = sanitize(labels[i], labelMax);
      const reply = sanitize(replies[i], replyMax);
      parts.push(row + "," + label + "|" + reply);
    }
    const payload = parts.join(";");
    if (payload === alt.ePiNavLastPayload) return "";
    alt.ePiNavLastPayload = payload;
    return navOsc + payload + "\\x07";
  }

  // Labels and replies are attacker-influenced (they contain model output), so
  // strip control characters and field separators before embedding them in an
  // OSC: otherwise a crafted reply could inject its own escape sequence.
  function sanitize(value, max) {
    return String(value ?? "").replace(unsafeLabel, " ").slice(0, max);
  }

  globalThis.__E_PI_TUI_ALT_SCREEN = true;
})();
`;
}

/**
 * Injector for `interactive-mode.js`.
 *
 * Replaces the `renderWidgetContainer(this.widgetContainerAbove, …)` hunk.
 * With an external composer the host owns the input dock, so the widget
 * container above the editor must not reserve an empty-state spacer.
 *
 * Present on every supported line (0.84 and 0.85 both define
 * `renderWidgetContainer` with the same signature).
 */
function interactiveModeInjector() {
  return `
(() => {
  const enabled = () => process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";
  if (typeof InteractiveMode === "undefined") return;
  const P = InteractiveMode.prototype;
  if (P.__ePiInjected) return;
  P.__ePiInjected = true;

  const upstream = P.renderWidgetContainer;
  P.renderWidgetContainer = function (container, widgets, spacerWhenEmpty, leadingSpacer) {
    if (enabled() && container === this.widgetContainerAbove) {
      return upstream.call(this, container, widgets, false, leadingSpacer);
    }
    return upstream.call(this, container, widgets, spacerWhenEmpty, leadingSpacer);
  };

  globalThis.__E_PI_TUI_INTERACTIVE_MODE = true;
})();
`;
}

/** Module basename → injector. Matched on the URL suffix. */
const INJECTORS = [
  { suffix: "/dist/tui-alt-screen.js", name: "tui-alt-screen", inject: altScreenInjector },
  { suffix: "/dist/modes/interactive/interactive-mode.js", name: "interactive-mode", inject: interactiveModeInjector },
];

/**
 * Read a module's source as text.
 *
 * Returns null when Node hands us a format we cannot rewrite — notably
 * CommonJS, where `source` is null because the loader has already wrapped it.
 * Pi ships as ESM, so this is a guard for unexpected modules, not a normal path.
 */
function readSource(result) {
  const raw = result.source;
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (raw && raw.buffer instanceof ArrayBuffer) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return null;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  for (const target of INJECTORS) {
    if (!url.endsWith(target.suffix)) continue;
    const source = readSource(result);
    if (source === null) {
      // Cannot rewrite: leave the module untouched rather than throw, so pi
      // still starts and simply runs without this piece of E-Pi behavior.
      process.emitWarning?.(`[e-pi] skipping ${target.name} injection: unreadable source (${result.format})`);
      return result;
    }
    return { ...result, source: `${source}\n${target.inject()}` };
  }

  return result;
}

/**
 * Exported for tests: the wire formats above must stay byte-identical to what
 * the host encodes and decodes, so the constants are asserted directly rather
 * than re-derived in the test.
 */
export const PROTOCOL = {
  ESC,
  ST,
  WHEEL_PATTERN,
  SCROLL_TO_ROW_PATTERN,
  SCROLL_TO_BOTTOM_INPUT,
  VIEWPORT_INPUT_PREFIX,
  VIEWPORT_OSC_PREFIX,
  NAV_OSC_PREFIX,
  END_SYNCHRONIZED,
};
