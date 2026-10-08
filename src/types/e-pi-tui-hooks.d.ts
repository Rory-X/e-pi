/**
 * Types for E-Pi's runtime TUI hooks.
 *
 * The hooks ship as plain `.mjs` so the sidecar Node can load them without a
 * build step; TypeScript cannot infer types across that boundary. This file is
 * deliberately free of top-level imports/exports so it stays ambient: a
 * `declare module` for a *relative* path is only honored in an ambient file.
 */

type TuiHookProtocol = {
  /** ESC (0x1b). */
  readonly ESC: string;
  /** String terminator: ESC + backslash. */
  readonly ST: string;
  readonly WHEEL_PATTERN: RegExp;
  readonly SCROLL_TO_ROW_PATTERN: RegExp;
  readonly SCROLL_TO_BOTTOM_INPUT: string;
  readonly VIEWPORT_INPUT_PREFIX: string;
  readonly VIEWPORT_OSC_PREFIX: string;
  readonly NAV_OSC_PREFIX: string;
  readonly END_SYNCHRONIZED: string;
};

declare module "*/e-pi-tui-hooks.mjs" {
  export const PROTOCOL: TuiHookProtocol;
}
