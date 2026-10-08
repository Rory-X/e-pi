import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAutomationExecutor } from "../electron/main/services/automation-executor";
import type {
  AutomationInput,
  AutomationRun,
  ModelManagementState,
  PiRuntimeState,
  SessionSummary,
  SkillRecord,
} from "../src/types/contracts";

describe("automation Pi execution", () => {
  let root: string;
  let config: AutomationInput;
  let run: AutomationRun;
  let state: PiRuntimeState;
  let session: SessionSummary;
  let catalog: ModelManagementState;
  let skills: SkillRecord[];
  const runtime = {
    activeSessionPath: undefined as string | undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    submit: vi.fn(),
    getStates: vi.fn((): Record<string, PiRuntimeState> => ({ [session.path]: state })),
  };
  const sessions = { create: vi.fn(async () => session), rename: vi.fn(async () => undefined) };
  const models = { list: vi.fn(async () => catalog) };
  const skillService = { list: vi.fn(async () => skills) };
  const changed = vi.fn(async () => undefined);
  const attach = vi.fn(async () => undefined);
  const execute = (controller = new AbortController()) =>
    createAutomationExecutor({
      runtime,
      sessions,
      models,
      skills: skillService,
      sessionsChanged: changed,
      notify: vi.fn(),
    }).launch(config, run, attach, controller.signal);

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime.activeSessionPath = undefined;
    runtime.start.mockImplementation(async () => undefined);
    root = await realpath(await mkdtemp(join(tmpdir(), "epi-auto-executor-")));
    config = {
      name: "A longer automation task name",
      prompt: "Check dependencies",
      cwd: root,
      model: { provider: "saved", id: "saved-model" },
      thinkingLevel: "high",
      timezone: "Asia/Shanghai",
      timeoutMinutes: 60,
      notifyOnSuccess: false,
      schedule: { kind: "weekly", weekdays: [1], time: "09:00" },
    };
    session = {
      path: join(root, "session.jsonl"),
      id: "session-id",
      cwd: root,
      createdAt: "2026-10-05T01:00Z",
      modifiedAt: "2026-10-05T01:00Z",
      firstMessage: "",
      searchText: "",
      messageCount: 0,
    };
    run = {
      id: "run",
      taskId: "task",
      taskName: config.name,
      cwd: root,
      timezone: config.timezone,
      scheduledAt: "2026-10-05T01:00Z",
      createdAt: "2026-10-05T01:00Z",
      trigger: "schedule",
      status: "starting",
      elapsedMs: 0,
      config,
    };
    state = {
      status: "running",
      sessionPath: session.path,
      generation: 1,
      activity: "idle",
      model: config.model,
      thinkingLevel: "high",
    };
    catalog = {
      defaultModel: { provider: "other", id: "default" },
      providers: [
        {
          id: "saved",
          name: "Saved provider",
          configured: true,
          supportsApiKey: true,
          supportsOAuth: false,
          models: [
            {
              provider: "saved",
              id: "saved-model",
              name: "Saved model",
              api: "test",
              reasoning: true,
              available: true,
              contextWindow: 200000,
              maxTokens: 10000,
            },
          ],
        },
      ],
    };
    skills = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, attaches and labels a new session before submitting with fixed model and thinking", async () => {
    await execute();
    expect(sessions.create).toHaveBeenCalledWith(root);
    expect(attach).toHaveBeenCalledWith(session.path);
    expect(sessions.rename).toHaveBeenCalledWith(session.path, expect.stringContaining(config.name), {
      automation: true,
    });
    expect(runtime.start).toHaveBeenCalledWith(
      session.path,
      root,
      expect.objectContaining({ background: true, model: config.model, thinkingLevel: "high" }),
    );
    expect(runtime.submit).toHaveBeenCalledExactlyOnceWith(session.path, config.prompt);
    expect(attach.mock.invocationCallOrder[0]).toBeLessThan(runtime.submit.mock.invocationCallOrder[0]);
  });
  it("fails before session creation when the saved model is unavailable", async () => {
    catalog.providers[0].models[0].available = false;
    await expect(execute()).rejects.toThrow("unavailable");
    expect(sessions.create).not.toHaveBeenCalled();
    expect(runtime.submit).not.toHaveBeenCalled();
  });
  it("verifies Pi actually selected the saved model instead of submitting to a fallback", async () => {
    state.model = { provider: "other", id: "default" };
    await expect(execute()).rejects.toThrow("saved model");
    expect(runtime.submit).not.toHaveBeenCalled();
  });
  it("rejects clamped thinking levels rather than silently changing execution", async () => {
    state.thinkingLevel = "medium";
    await expect(execute()).rejects.toThrow("thinking level");
    expect(runtime.submit).not.toHaveBeenCalled();
  });
  it("validates a saved Skill in the task directory and submits its explicit invocation", async () => {
    config.skill = { name: "review", filePath: join(root, "review", "SKILL.md") };
    skills = [
      {
        ...config.skill,
        baseDir: join(root, "review"),
        description: "review",
        source: "project",
        managed: true,
        enabled: true,
      },
    ];
    await execute();
    expect(skillService.list).toHaveBeenCalledWith(root);
    expect(runtime.submit).toHaveBeenCalledWith(session.path, "/skill:review Check dependencies");
  });
  it("does not submit if a saved Skill disappeared", async () => {
    config.skill = { name: "review", filePath: join(root, "review", "SKILL.md") };
    await expect(execute()).rejects.toThrow("no longer available");
    expect(sessions.create).not.toHaveBeenCalled();
  });
  it("does not start anything after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute(controller)).rejects.toThrow("aborted");
    expect(models.list).not.toHaveBeenCalled();
  });
  it("cancels a launch that was stopped while Pi was becoming ready", async () => {
    const controller = new AbortController();
    runtime.start.mockImplementation(async () => {
      controller.abort();
    });
    await expect(execute(controller)).rejects.toThrow("aborted");
    expect(runtime.stop).toHaveBeenCalledWith(session.path);
    expect(runtime.submit).not.toHaveBeenCalled();
  });
  it("does not start in a directory that no longer exists", async () => {
    config.cwd = join(root, "gone");
    await expect(execute()).rejects.toThrow("ENOENT");
    expect(models.list).not.toHaveBeenCalled();
  });
  it("keeps a completed foreground session usable and releases background or stopped sessions", async () => {
    const executor = createAutomationExecutor({
      runtime,
      sessions,
      models,
      skills: skillService,
      sessionsChanged: changed,
      notify: vi.fn(),
    });
    runtime.activeSessionPath = session.path;
    await executor.stop(session.path, "success");
    expect(runtime.stop).not.toHaveBeenCalled();
    await executor.stop(session.path, "timed_out");
    expect(runtime.stop).toHaveBeenCalledWith(session.path);
    runtime.stop.mockClear();
    runtime.activeSessionPath = "another-session";
    await executor.stop(session.path, "success");
    expect(runtime.stop).toHaveBeenCalledWith(session.path);
  });
});
