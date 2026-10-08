import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ePiBridge from "../resources/e-pi-bridge";

describe("automation bridge completion", () => {
  let root: string;
  let session: string;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "epi-auto-bridge-"));
    session = join(root, "run.jsonl");
    handlers.clear();
    ePiBridge({
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      events: { on: vi.fn() },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      setThinkingLevel: vi.fn(),
    } as never);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const ctx = () => ({
    getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => session, getEntries: () => [] },
    ui: { setWorkingMessage: vi.fn() },
  });
  const message = (stopReason: string) => ({
    message: {
      role: "assistant",
      stopReason,
      errorMessage: stopReason === "error" ? "API unavailable" : undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  });
  const result = async () => {
    let value: { status: string; turnResult?: { status: string; serial: number; error?: string } } | undefined;
    await vi.waitFor(async () => {
      value = JSON.parse(await readFile(`${session}.e-pi-activity.json`, "utf8"));
      expect(value?.turnResult).toBeDefined();
    });
    return value!;
  };

  it.each([
    ["stop", "success"],
    ["error", "error"],
    ["aborted", "cancelled"],
  ])("reports assistant stopReason=%s as %s after the run settles", async (stopReason, expected) => {
    handlers.get("message_end")!(message(stopReason), ctx());
    handlers.get("agent_settled")!({}, ctx());
    const value = await result();
    expect(value.status).toBe("idle");
    expect(value.turnResult?.status).toBe(expected);
    expect(value.turnResult?.serial).toBe(1);
    const errors: Record<string, string | undefined> = {
      error: "API unavailable",
      cancelled: "Pi run was interrupted.",
    };
    expect(value.turnResult?.error).toBe(errors[expected]);
  });
  it("reports a successful provider retry according to its final response", async () => {
    handlers.get("message_end")!(message("error"), ctx());
    handlers.get("message_end")!(message("stop"), ctx());
    handlers.get("agent_settled")!({}, ctx());
    expect((await result()).turnResult?.status).toBe("success");
  });
});
