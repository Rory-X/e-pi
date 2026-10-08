import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationService } from "../electron/main/services/automation-service";
import type { AutomationExecutor } from "../electron/main/services/automation-service";
import type { AutomationInput, AutomationRun, PiRuntimeState } from "../src/types/contracts";

describe("AutomationService", () => {
  let root: string;
  let directory: string;
  let clock: number;
  let file: string;
  let executor: AutomationExecutor;
  let service: AutomationService;
  let counter: number;
  const initial = Date.parse("2026-10-05T00:00:00Z");
  const input = (overrides: Partial<AutomationInput> = {}): AutomationInput => ({
    name: "Daily review",
    prompt: "Check dependencies",
    cwd: directory,
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    timeoutMinutes: 60,
    schedule: { kind: "interval", every: 1, unit: "hours", anchor: new Date(initial + 3_600_000).toISOString() },
    timezone: "Asia/Shanghai",
    notifyOnSuccess: false,
    ...overrides,
  });
  const create = async (overrides: Partial<AutomationInput> = {}) =>
    (await service.save({ input: input(overrides) })).tasks.at(-1)!;
  const flush = async () => {
    await Promise.allSettled(vi.mocked(executor.launch).mock.results.map((result) => result.value));
    // Drain queued state/persistence work after the executor promises settle.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await service.list();
    }
  };
  const current = async (taskId: string) => (await service.list()).runs.findLast((run) => run.taskId === taskId)!;
  const observe = async (run: AutomationRun, state: Partial<PiRuntimeState>) => {
    await service.observe({ status: "running", sessionPath: run.sessionPath!, generation: 1, ...state });
    await flush();
  };
  const succeed = (run: AutomationRun) => observe(run, { turnResult: { serial: 1, status: "success" } });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "epi-automations-"));
    directory = join(root, "project");
    await mkdir(directory);
    clock = initial;
    counter = 0;
    file = join(root, "automations.json");
    executor = {
      launch: vi.fn(async (_config, _run, attach, signal) => {
        signal.throwIfAborted();
        await attach(join(root, `session-${++counter}.jsonl`));
      }),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    service = new AutomationService(file, executor, () => clock);
  });
  afterEach(async () => {
    await service.shutdown();
    await flush();
    await rm(root, { recursive: true, force: true });
  });

  it("persists task config and resumes the same schedule after reopening", async () => {
    const task = await create();
    const reopened = new AutomationService(file, executor, () => clock);
    expect((await reopened.list()).tasks[0]).toEqual(task);
    expect(task.nextRunAt).toBe("2026-10-05T01:00:00.000Z");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });
  it("catches up only the latest occurrence and records the older ones", async () => {
    const task = await create();
    clock += 5.5 * 3_600_000;
    await Promise.all([service.tick(), service.tick()]);
    await flush();
    const runs = (await service.list()).runs;
    expect(runs.map((run) => run.status)).toEqual(["missed", "running"]);
    expect(runs[0].missedCount).toBe(4);
    expect(runs[1].scheduledAt).toBe("2026-10-05T05:00:00.000Z");
    expect((await service.list()).tasks[0].nextRunAt).toBe("2026-10-05T06:00:00.000Z");
    expect(executor.launch).toHaveBeenCalledTimes(1);
    await service.tick();
    await flush();
    expect((await current(task.id)).status).toBe("running");
    expect(executor.launch).toHaveBeenCalledTimes(1);
  });
  it("consumes a one-time schedule once, including a missed one-time occurrence", async () => {
    const task = await create({ schedule: { kind: "once", localDateTime: "2026-10-05T09:00" } });
    clock += 2 * 3_600_000;
    await service.tick();
    await flush();
    await succeed(await current(task.id));
    await service.tick();
    await flush();
    expect(executor.launch).toHaveBeenCalledTimes(1);
    expect((await service.list()).tasks[0].nextRunAt).toBeUndefined();
  });
  it("skips a task's next occurrence while its previous run is outstanding", async () => {
    const task = await create({ timeoutMinutes: 180 });
    clock += 3_600_000;
    await service.tick();
    await flush();
    clock += 3_600_000;
    await service.tick();
    await flush();
    expect((await current(task.id)).status).toBe("skipped");
    expect(executor.launch).toHaveBeenCalledTimes(1);
    await expect(service.runNow(task.id)).rejects.toThrow("outstanding");
  });
  it("serializes canonical directories and runs at most two different directories", async () => {
    const secondDir = join(root, "second");
    const thirdDir = join(root, "third");
    const alias = join(root, "alias");
    await mkdir(secondDir);
    await mkdir(thirdDir);
    await symlink(directory, alias);
    const a = await create();
    const a2 = await create({ cwd: alias, name: "same dir" });
    const b = await create({ cwd: secondDir });
    const c = await create({ cwd: thirdDir });
    expect(a2.cwd).toBe(a.cwd);
    clock += 3_600_000;
    await service.tick();
    await flush();
    expect(executor.launch).toHaveBeenCalledTimes(2);
    expect((await current(a.id)).status).toBe("running");
    expect((await current(b.id)).status).toBe("running");
    expect((await current(a2.id)).status).toBe("queued");
    expect((await current(c.id)).status).toBe("queued");
    await succeed(await current(a.id));
    expect((await current(a2.id)).status).toBe("running");
    expect((await current(c.id)).status).toBe("queued");
  });
  it("keeps waiting runs in concurrency slots and excludes human wait from timeout", async () => {
    const task = await create({ timeoutMinutes: 1 });
    const next = await create({ name: "queued" });
    await service.runNow(task.id);
    await service.runNow(next.id);
    await flush();
    const run = await current(task.id);
    clock += 20_000;
    await observe(run, { waitingUser: { kind: "permission", detail: "Allow edit?" } });
    clock += 8 * 3_600_000;
    await service.tick();
    await flush();
    const waiting = (await service.list()).runs.find((item) => item.id === run.id)!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.elapsedMs).toBe(20_000);
    expect(
      (await service.list()).runs.find((item) => item.taskId === next.id && item.status === "queued"),
    ).toBeDefined();
    await observe(run, { waitingUser: null });
    clock += 39_000;
    await service.tick();
    expect((await service.list()).runs.find((item) => item.id === run.id)?.status).toBe("running");
    clock += 1_000;
    await service.tick();
    await flush();
    expect((await service.list()).runs.find((item) => item.id === run.id)?.status).toBe("timed_out");
    expect(executor.stop).toHaveBeenCalledWith(run.sessionPath, "timed_out");
  });
  it("does not count sleep toward active timeout and catches up on resume", async () => {
    const task = await create({ timeoutMinutes: 1 });
    await service.runNow(task.id);
    await flush();
    const run = await current(task.id);
    clock += 10_000;
    await service.tick();
    service.suspend();
    clock += 2 * 3_600_000;
    await service.tick();
    await service.resume();
    await flush();
    expect((await service.list()).runs.find((item) => item.id === run.id)?.status).toBe("running");
    expect((await service.list()).runs.find((item) => item.id === run.id)?.elapsedMs).toBe(10_000);
    expect((await current(task.id)).status).toBe("skipped");
    clock += 50_000;
    await service.tick();
    await flush();
    expect((await service.list()).runs.find((item) => item.id === run.id)?.status).toBe("timed_out");
  });
  it("pausing cancels queued occurrences, preserves current runs, and resume skips the paused period", async () => {
    const first = await create();
    const second = await create({ name: "second" });
    await service.runNow(first.id);
    await service.runNow(second.id);
    await flush();
    await service.setEnabled(first.id, false);
    await service.setEnabled(second.id, false);
    expect((await current(first.id)).status).toBe("running");
    expect((await current(second.id)).status).toBe("cancelled");
    clock += 3.5 * 3_600_000;
    await service.setEnabled(first.id, true);
    expect((await service.list()).tasks[0].nextRunAt).toBe("2026-10-05T04:00:00.000Z");
  });
  it("deletion cancels the queue while retaining current runs, history and session origin", async () => {
    const first = await create();
    const second = await create({ name: "second" });
    await service.runNow(first.id);
    await service.runNow(second.id);
    await flush();
    const run = await current(first.id);
    await service.remove(first.id);
    await service.remove(second.id);
    expect((await current(first.id)).status).toBe("running");
    expect((await current(second.id)).status).toBe("cancelled");
    await succeed(run);
    expect((await current(first.id)).status).toBe("success");
    expect((await service.list()).tasks[0].deletedAt).toBeDefined();
    const decorated = service.decorateSessions([{ path: run.sessionPath } as never]);
    expect(decorated[0].automation).toEqual({ taskId: first.id, runId: run.id });
  });
  it("edits only future config, retaining the current run snapshot and interval anchor", async () => {
    const task = await create();
    await service.runNow(task.id);
    await flush();
    const run = await current(task.id);
    await service.save({
      id: task.id,
      input: input({ prompt: "New instructions", model: { provider: "other", id: "new" } }),
    });
    expect((await service.list()).runs.find((item) => item.id === run.id)?.config.prompt).toBe("Check dependencies");
    expect((await service.list()).tasks[0].nextRunAt).toBe(task.nextRunAt);
  });
  it("run now is allowed while paused and does not advance the schedule", async () => {
    const task = await create();
    await service.setEnabled(task.id, false);
    await service.runNow(task.id);
    await flush();
    expect((await current(task.id)).status).toBe("running");
    expect((await service.list()).tasks[0].nextRunAt).toBeUndefined();
  });
  it("does not retry a failed launch, but future schedule occurrences still run", async () => {
    executor.launch = vi.fn(async () => {
      throw new Error("Credentials unavailable");
    });
    const task = await create();
    await service.runNow(task.id);
    await flush();
    await service.tick();
    expect((await current(task.id)).status).toBe("failed");
    expect(executor.launch).toHaveBeenCalledTimes(1);
    clock += 3_600_000;
    await service.tick();
    await flush();
    expect(executor.launch).toHaveBeenCalledTimes(2);
  });
  it("recognizes errors and cancellation without incorrectly declaring success", async () => {
    const task = await create();
    await service.runNow(task.id);
    await flush();
    await observe(await current(task.id), { turnResult: { serial: 1, status: "error", error: "Provider failed" } });
    expect((await current(task.id)).status).toBe("failed");
    await service.runNow(task.id);
    await flush();
    await observe(await current(task.id), { turnResult: { serial: 1, status: "cancelled" } });
    expect((await current(task.id)).status).toBe("cancelled");
  });
  it("recognizes completion even when the busy update was missed", async () => {
    const task = await create();
    await service.runNow(task.id);
    await flush();
    await succeed(await current(task.id));
    expect((await current(task.id)).status).toBe("success");
    expect(executor.notify).not.toHaveBeenCalled();
  });
  it("honors success notification preferences and deduplicates repeated waiting states", async () => {
    const task = await create({ notifyOnSuccess: true });
    await service.runNow(task.id);
    await flush();
    const run = await current(task.id);
    await observe(run, { waitingUser: { kind: "ask_user" } });
    await observe(run, { waitingUser: { kind: "ask_user" } });
    expect(executor.notify).toHaveBeenCalledTimes(1);
    await observe(run, { waitingUser: null });
    await succeed(run);
    expect(executor.notify).toHaveBeenCalledTimes(2);
  });
  it("marks interrupted runs failed on restart without replaying the old prompt", async () => {
    const task = await create();
    await service.runNow(task.id);
    await flush();
    await service.shutdown();
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.runs[0].status = "running";
    await writeFile(file, JSON.stringify(stored));
    const recovered = new AutomationService(file, executor, () => clock);
    expect((await recovered.list()).runs[0].status).toBe("failed");
    await recovered.tick();
    expect(executor.launch).toHaveBeenCalledTimes(1);
  });
  it("replaces an older persisted queued occurrence with the latest missed one on recovery", async () => {
    const task = await create();
    await service.shutdown();
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.tasks[0].nextRunAt = "2026-10-05T02:00:00.000Z";
    stored.runs = [
      {
        id: "old-queue",
        taskId: task.id,
        taskName: task.name,
        cwd: task.cwd,
        timezone: task.timezone,
        scheduledAt: "2026-10-05T01:00:00.000Z",
        createdAt: task.createdAt,
        status: "queued",
        trigger: "schedule",
        elapsedMs: 0,
        config: task,
      },
    ];
    await writeFile(file, JSON.stringify(stored));
    clock += 5.5 * 3_600_000;
    service = new AutomationService(file, executor, () => clock);
    await service.tick();
    await flush();
    expect((await service.list()).runs.find((run) => run.id === "old-queue")?.status).toBe("missed");
    expect((await current(task.id)).scheduledAt).toBe("2026-10-05T05:00:00.000Z");
    expect(executor.launch).toHaveBeenCalledTimes(1);
  });
  it("two waiting runs retain both slots, keeping a third directory queued", async () => {
    const secondDir = join(root, "second");
    const thirdDir = join(root, "third");
    await mkdir(secondDir);
    await mkdir(thirdDir);
    const a = await create();
    const b = await create({ cwd: secondDir });
    const c = await create({ cwd: thirdDir });
    await service.runNow(a.id);
    await service.runNow(b.id);
    await service.runNow(c.id);
    await flush();
    await observe(await current(a.id), { waitingUser: { kind: "permission" } });
    await observe(await current(b.id), { waitingUser: { kind: "ask_user" } });
    await service.tick();
    expect((await current(c.id)).status).toBe("queued");
    expect(executor.launch).toHaveBeenCalledTimes(2);
    await service.stop((await current(a.id)).id);
    await flush();
    expect((await current(c.id)).status).toBe("running");
  });
  it("stops queued work without launching it", async () => {
    const a = await create();
    const b = await create({ name: "second" });
    await service.runNow(a.id);
    await service.runNow(b.id);
    await flush();
    await service.stop((await current(b.id)).id);
    await succeed(await current(a.id));
    expect((await current(b.id)).status).toBe("cancelled");
    expect(executor.launch).toHaveBeenCalledTimes(1);
  });
  it("aborts a starting run and prevents shutdown from submitting another prompt", async () => {
    let launchSignal: AbortSignal | undefined;
    executor.launch = vi.fn(async (_config, _run, attach, signal) => {
      launchSignal = signal;
      await attach(join(root, "starting.jsonl"));
      signal.throwIfAborted();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
    });
    const task = await create();
    await service.runNow(task.id);
    await vi.waitFor(async () => expect((await current(task.id)).sessionPath).toBeDefined());
    await service.shutdown();
    await flush();
    expect(launchSignal?.aborted).toBe(true);
    expect((await current(task.id)).status).toBe("failed");
    await expect(service.runNow(task.id)).rejects.toThrow("shutting down");
  });
  it("retains the newest 100 terminal records and every outstanding record without deleting sessions", async () => {
    const task = await create();
    await service.shutdown();
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.runs = Array.from({ length: 110 }, (_, index) => ({
      id: `run-${index}`,
      taskId: task.id,
      taskName: task.name,
      cwd: task.cwd,
      timezone: task.timezone,
      scheduledAt: task.createdAt,
      createdAt: task.createdAt,
      status: index === 0 ? "queued" : "success",
      elapsedMs: 0,
      trigger: "manual",
      config: task,
    }));
    await writeFile(file, JSON.stringify(stored));
    service = new AutomationService(file, executor, () => clock);
    const runs = (await service.list()).runs;
    expect(runs).toHaveLength(101);
    expect(runs[0].id).toBe("run-0");
    expect(runs[1].id).toBe("run-10");
    expect(executor.stop).not.toHaveBeenCalled();
  });
  it("rejects invalid and past schedules and leaves malformed storage untouched", async () => {
    await expect(create({ schedule: { kind: "once", localDateTime: "2026-10-04T09:00" } })).rejects.toThrow("future");
    await expect(create({ timeoutMinutes: 0 })).rejects.toThrow("timeout");
    await expect(create({ cwd: "relative" })).rejects.toThrow("absolute");
    await writeFile(file, "{ corrupt");
    const broken = new AutomationService(file, executor, () => clock);
    await expect(broken.list()).rejects.toThrow(/JSON|Unexpected/);
    expect(await readFile(file, "utf8")).toBe("{ corrupt");
  });
});
