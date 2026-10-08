import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  root: "",
  spawn: vi.fn(),
  config: {
    systemPrompt: "",
    appendSystemPrompt: "",
    thinkingLevel: "low",
    contextFiles: true,
  },
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => context.root, getAppPath: () => context.root },
  nativeTheme: { shouldUseDarkColors: false },
}));
vi.mock("node-pty", () => ({ spawn: context.spawn }));
vi.mock("../electron/main/services/pi-agent-loader", () => ({ piCliEntry: () => "/pi/cli.js" }));
vi.mock("../electron/main/services/app-settings-service", () => ({ isTuiOptimizationsEnabled: () => false }));
vi.mock("../electron/main/services/pi-settings-service", () => ({
  ensureAutoThemeSetting: vi.fn(),
  ensureEpiLightThemeFile: vi.fn(),
}));
vi.mock("../electron/main/services/debug-log", () => ({ debugLog: vi.fn() }));
vi.mock("../electron/main/services/agent-config-service", () => ({
  getAgentConfig: async () => ({ ...context.config }),
  agentConfigToArgs: (config: { thinkingLevel: string }) => ["--thinking", config.thinkingLevel],
}));

import { PiRuntime } from "../electron/main/services/pi-runtime";

class FakePty {
  pid = 123;
  exit?: (event: { exitCode: number; signal: number }) => void;
  write = vi.fn((value: string) => {
    if (value === "\x04") this.kill();
  });
  resize = vi.fn();
  kill = vi.fn(() => this.exit?.({ exitCode: 0, signal: 0 }));
  onData = vi.fn(() => ({ dispose: vi.fn() }));
  onExit = vi.fn((listener: typeof this.exit) => {
    this.exit = listener;
    return { dispose: vi.fn() };
  });
}

describe("automation runtime launch", () => {
  let root: string;
  let runtime: PiRuntime;
  let session: string;
  let child: FakePty;
  let autoReady: boolean;
  let previousResources: string;
  const ready = async () =>
    writeFile(
      `${session}.e-pi-activity.json`,
      JSON.stringify({
        status: "idle",
        model: { provider: "saved", id: "pinned" },
        thinkingLevel: "high",
        turnResult: null,
      }),
    );
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "epi-auto-runtime-"));
    context.root = root;
    context.spawn.mockReset();
    previousResources = process.resourcesPath;
    Reflect.set(process, "resourcesPath", root);
    session = join(root, "session.jsonl");
    await writeFile(session, "{}\n");
    child = new FakePty();
    autoReady = true;
    context.spawn.mockImplementation(() => {
      if (autoReady) void ready();
      return child;
    });
    runtime = new PiRuntime();
  });
  afterEach(async () => {
    await runtime.stop();
    Reflect.set(process, "resourcesPath", previousResources);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the foreground session while passing saved model and thinking flags", async () => {
    runtime.setActiveSession("foreground-session");
    await runtime.start(session, root, {
      background: true,
      model: { provider: "saved", id: "pinned" },
      thinkingLevel: "high",
    });
    expect(runtime.activeSessionPath).toBe("foreground-session");
    const args = context.spawn.mock.calls[0][1] as string[];
    expect(args.slice(-6)).toEqual(["--thinking", "high", "--provider", "saved", "--model", "pinned"]);
    expect(runtime.getStates()[session].model).toEqual({ provider: "saved", id: "pinned" });
    expect(runtime.getStates()[session].thinkingLevel).toBe("high");
    expect(context.config.thinkingLevel).toBe("low");
  });
  it("lets normal session selection change the foreground session", async () => {
    await runtime.start(session, root);
    expect(runtime.activeSessionPath).toBe(session);
  });
  it("cancels startup immediately instead of waiting for the readiness timeout", async () => {
    autoReady = false;
    const controller = new AbortController();
    const starting = runtime.start(session, root, { background: true, signal: controller.signal });
    const rejection = starting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(context.spawn).toHaveBeenCalledOnce());
    controller.abort();
    expect(await rejection).toMatchObject({ message: "Pi launch was cancelled." });
    expect(child.kill).toHaveBeenCalled();
    expect(runtime.isRunning(session)).toBe(false);
  });
  it("forwards completed-turn outcomes even when only the idle sidecar was observed", async () => {
    await runtime.start(session, root);
    const content = JSON.parse(await readFile(`${session}.e-pi-activity.json`, "utf8"));
    content.turnResult = { serial: 1, status: "error", error: "Provider rejected request" };
    await writeFile(`${session}.e-pi-activity.json`, JSON.stringify(content));
    await vi.waitFor(() =>
      expect(runtime.getStates()[session].turnResult).toEqual({
        serial: 1,
        status: "error",
        error: "Provider rejected request",
      }),
    );
  });
});
