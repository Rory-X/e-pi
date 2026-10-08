import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { dueOccurrences, nextOccurrence, validateSchedule } from "../../../src/lib/automationSchedule";
import type {
  AutomationInput,
  AutomationRun,
  AutomationRunStatus,
  AutomationSaveRequest,
  AutomationState,
  AutomationTask,
  PiRuntimeState,
  SessionSummary,
} from "../../../src/types/contracts";

const ACTIVE = new Set<AutomationRunStatus>(["starting", "running", "waiting"]);
const OUTSTANDING = new Set<AutomationRunStatus>(["queued", ...ACTIVE]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AutomationExecutor {
  launch(
    config: AutomationInput,
    run: AutomationRun,
    attach: (sessionPath: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  stop(sessionPath: string, reason?: AutomationRunStatus): Promise<void>;
  notify(run: AutomationRun): void;
}

interface StoredAutomations extends AutomationState {
  version: 1;
  origins: Record<string, { taskId: string; runId: string }>;
}

export class AutomationService {
  #data: StoredAutomations = { version: 1, tasks: [], runs: [], origins: {} };
  #initialized = false;
  #chain: Promise<unknown> = Promise.resolve();
  #timer?: ReturnType<typeof setInterval>;
  #tickPending?: Promise<void>;
  #listeners = new Set<(state: AutomationState) => void>();
  #controllers = new Map<string, AbortController>();
  #launches = new Map<string, Promise<void>>();
  #stopping = new Set<string>();
  #accountedAt = new Map<string, number>();
  #checkpoint = 0;
  #suspended = false;
  #closed = false;
  #storageError?: string;
  #catchingUp = true;

  constructor(
    readonly filePath: string,
    readonly executor: AutomationExecutor,
    readonly now: () => number = Date.now,
  ) {}

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation);
    this.#chain = result.catch(() => undefined);
    return result;
  }

  async #load(): Promise<void> {
    if (this.#initialized) return;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as StoredAutomations;
      if (
        value.version !== 1 ||
        !Array.isArray(value.tasks) ||
        !Array.isArray(value.runs) ||
        !value.origins ||
        typeof value.origins !== "object"
      )
        throw new Error("Invalid automations file.");
      // Validate schedule data before it can drive timers. Never overwrite a corrupt store.
      for (const task of value.tasks) {
        validateSchedule(task.schedule, task.timezone);
        if (typeof task.id !== "string" || !isAbsolute(task.cwd)) throw new Error("Invalid automation task.");
      }
      this.#data = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#initialized = true;
    for (const run of this.#data.runs) {
      if (!ACTIVE.has(run.status)) continue;
      run.status = "failed";
      run.detail = "E-Pi exited before this run finished. Review its session before running again.";
      run.finishedAt = this.#iso();
      this.executor.notify(structuredClone(run));
    }
    this.#checkpoint = this.now();
    await this.#persist();
  }

  #iso(at = this.now()): string {
    return new Date(at).toISOString();
  }
  #snapshot(): AutomationState {
    return structuredClone({ tasks: this.#data.tasks, runs: this.#data.runs, error: this.#storageError });
  }
  #emit(): void {
    for (const listener of this.#listeners) listener(this.#snapshot());
  }
  onUpdated(listener: (state: AutomationState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async list(): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      return this.#snapshot();
    });
  }
  decorateSessions(sessions: SessionSummary[]): SessionSummary[] {
    return sessions.map((session) => ({ ...session, automation: this.#data.origins[session.path] }));
  }
  ownsSession(path: string): boolean {
    return this.#data.runs.some(
      (run) => run.sessionPath === path && (ACTIVE.has(run.status) || this.#stopping.has(run.id)),
    );
  }

  async start(): Promise<void> {
    await this.list();
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1_000);
    this.#timer.unref();
    await this.tick();
  }

  suspend(): void {
    this.#suspended = true;
  }
  async resume(): Promise<void> {
    await this.#exclusive(async () => {
      this.#suspended = false;
      this.#catchingUp = true;
      for (const run of this.#data.runs) if (ACTIVE.has(run.status)) this.#accountedAt.set(run.id, this.now());
    });
    await this.tick();
  }

  async #persist(): Promise<void> {
    // Keep all outstanding runs, plus the newest 100 finished records per task.
    const kept = new Map<string, number>();
    this.#data.runs = [...this.#data.runs]
      .reverse()
      .filter((run) => {
        if (OUTSTANDING.has(run.status) || this.#stopping.has(run.id)) return true;
        const count = kept.get(run.taskId) ?? 0;
        kept.set(run.taskId, count + 1);
        return count < 100;
      })
      .reverse();
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#data), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
      this.#storageError = undefined;
    } catch (error) {
      this.#storageError = `Automations stopped: could not save their state. ${String(error)}`;
      this.#emit();
      throw error;
    }
    this.#emit();
  }

  #task(id: string): AutomationTask {
    const task = this.#data.tasks.find((item) => item.id === id && !item.deletedAt);
    if (!task) throw new Error("Automation no longer exists.");
    return task;
  }
  #cancelQueued(taskId: string, detail: string): void {
    for (const run of this.#data.runs)
      if (run.taskId === taskId && run.status === "queued") {
        run.status = "cancelled";
        run.finishedAt = this.#iso();
        run.detail = detail;
      }
  }

  async save(request: AutomationSaveRequest): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      if (this.#closed) throw new Error("E-Pi is shutting down.");
      const raw = request?.input;
      if (
        !raw ||
        typeof raw.name !== "string" ||
        !raw.name.trim() ||
        raw.name.trim().length > 100 ||
        typeof raw.prompt !== "string" ||
        !raw.prompt.trim() ||
        typeof raw.cwd !== "string" ||
        !isAbsolute(raw.cwd) ||
        !raw.model ||
        typeof raw.model.provider !== "string" ||
        !raw.model.provider.trim() ||
        typeof raw.model.id !== "string" ||
        !raw.model.id.trim() ||
        !THINKING.includes(raw.thinkingLevel) ||
        !Number.isInteger(raw.timeoutMinutes) ||
        raw.timeoutMinutes < 1 ||
        raw.timeoutMinutes > 10_080 ||
        typeof raw.notifyOnSuccess !== "boolean" ||
        typeof raw.timezone !== "string"
      ) {
        throw new Error("Enter a name, prompt, absolute directory, model and timeout (1–10080 minutes).");
      }
      if (
        raw.skill &&
        (typeof raw.skill.name !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.skill.name) ||
          typeof raw.skill.filePath !== "string" ||
          !isAbsolute(raw.skill.filePath))
      )
        throw new Error("Choose a valid Skill.");
      validateSchedule(raw.schedule, raw.timezone);
      const cwd = await realpath(raw.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory.");
      const previous = request.id ? this.#task(request.id) : undefined;
      const scheduleChanged =
        !previous ||
        previous.timezone !== raw.timezone ||
        JSON.stringify(previous.schedule) !== JSON.stringify(raw.schedule);
      const next = nextOccurrence(raw.schedule, raw.timezone, this.now());
      if (scheduleChanged && raw.schedule.kind === "once" && next === undefined) {
        throw new Error("A new one-time schedule must be in the future.");
      }
      const input: AutomationInput = {
        name: raw.name.trim(),
        prompt: raw.prompt.trim(),
        cwd,
        model: { ...raw.model },
        skill: raw.skill ? { ...raw.skill } : undefined,
        thinkingLevel: raw.thinkingLevel,
        schedule: structuredClone(raw.schedule),
        timezone: raw.timezone,
        timeoutMinutes: raw.timeoutMinutes,
        notifyOnSuccess: raw.notifyOnSuccess,
      };
      const task: AutomationTask = {
        ...input,
        id: previous?.id ?? randomUUID(),
        enabled: previous?.enabled ?? true,
        createdAt: previous?.createdAt ?? this.#iso(),
        updatedAt: this.#iso(),
        nextRunAt: previous && !scheduleChanged ? previous.nextRunAt : next === undefined ? undefined : this.#iso(next),
      };
      if (!task.enabled) task.nextRunAt = undefined;
      if (previous) {
        this.#cancelQueued(previous.id, "Task edited before this run started.");
        this.#data.tasks[this.#data.tasks.indexOf(previous)] = task;
      } else this.#data.tasks.push(task);
      await this.#persist();
      return this.#snapshot();
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      if (typeof enabled !== "boolean") throw new Error("Invalid enabled state.");
      const task = this.#task(id);
      if (task.enabled !== enabled) {
        task.enabled = enabled;
        task.updatedAt = this.#iso();
        const next = enabled ? nextOccurrence(task.schedule, task.timezone, this.now()) : undefined;
        task.nextRunAt = next === undefined ? undefined : this.#iso(next);
        if (!enabled) this.#cancelQueued(id, "Task paused before this run started.");
        await this.#persist();
      }
      return this.#snapshot();
    });
  }

  async remove(id: string): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      const task = this.#task(id);
      task.deletedAt = this.#iso();
      task.enabled = false;
      task.nextRunAt = undefined;
      this.#cancelQueued(id, "Task deleted before this run started.");
      await this.#persist();
      return this.#snapshot();
    });
  }

  #newRun(task: AutomationTask, scheduledAt: number, trigger: AutomationRun["trigger"]): AutomationRun {
    const run: AutomationRun = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      cwd: task.cwd,
      timezone: task.timezone,
      scheduledAt: this.#iso(scheduledAt),
      createdAt: this.#iso(),
      trigger,
      status: "queued",
      elapsedMs: 0,
      config: structuredClone(task),
    };
    this.#data.runs.push(run);
    return run;
  }
  #hasOutstanding(taskId: string): boolean {
    return this.#data.runs.some(
      (run) => run.taskId === taskId && (OUTSTANDING.has(run.status) || this.#stopping.has(run.id)),
    );
  }

  async runNow(id: string): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      if (this.#closed) throw new Error("E-Pi is shutting down.");
      const task = this.#task(id);
      if (this.#hasOutstanding(id)) throw new Error("This task already has an outstanding run.");
      this.#newRun(task, this.now(), "manual");
      await this.#persist();
      await this.#pump();
      return this.#snapshot();
    });
  }

  #account(run: AutomationRun): void {
    const last = this.#accountedAt.get(run.id) ?? this.now();
    if (!this.#suspended && run.status !== "waiting") run.elapsedMs += Math.max(0, this.now() - last);
    this.#accountedAt.set(run.id, this.now());
  }

  tick(): Promise<void> {
    if (this.#tickPending) return this.#tickPending;
    this.#tickPending = this.#exclusive(async () => {
      await this.#load();
      if (this.#closed || this.#suspended || this.#storageError) return;
      let changed = false;
      for (const run of this.#data.runs)
        if (ACTIVE.has(run.status)) {
          this.#account(run);
          if (run.status !== "waiting" && run.elapsedMs >= run.config.timeoutMinutes * 60_000) {
            this.#finish(run, "timed_out", `Exceeded ${run.config.timeoutMinutes} minutes of execution time.`);
            changed = true;
          }
        }
      for (const task of this.#data.tasks) {
        if (!task.enabled || task.deletedAt || !task.nextRunAt || Date.parse(task.nextRunAt) > this.now()) continue;
        const first = Date.parse(task.nextRunAt);
        const due = dueOccurrences(task.schedule, task.timezone, first, this.now());
        if (this.#catchingUp) {
          for (const queued of this.#data.runs) {
            if (
              queued.taskId === task.id &&
              queued.status === "queued" &&
              queued.trigger === "schedule" &&
              Date.parse(queued.scheduledAt) < due.latest
            ) {
              queued.status = "missed";
              queued.missedCount = 1;
              queued.finishedAt = this.#iso();
              queued.detail = "Superseded by the latest missed occurrence on recovery.";
            }
          }
        }
        task.nextRunAt = due.next === undefined ? undefined : this.#iso(due.next);
        if (due.count > 1) {
          const missed = this.#newRun(task, first, "schedule");
          missed.status = "missed";
          missed.finishedAt = this.#iso();
          missed.missedCount = due.count - 1;
          missed.detail = `${due.count - 1} older occurrences missed; only the latest is eligible for catch-up.`;
        }
        const blocked = this.#hasOutstanding(task.id);
        const run = this.#newRun(task, due.latest, "schedule");
        if (blocked) {
          run.status = "skipped";
          run.finishedAt = this.#iso();
          run.detail = "Previous run is still queued, running or waiting for input.";
        }
        changed = true;
      }
      this.#catchingUp = false;
      if (
        changed ||
        (this.now() - this.#checkpoint >= 10_000 && this.#data.runs.some((run) => ACTIVE.has(run.status)))
      ) {
        await this.#persist();
        this.#checkpoint = this.now();
      }
      await this.#pump();
    }).finally(() => {
      this.#tickPending = undefined;
    });
    return this.#tickPending;
  }

  async #pump(): Promise<void> {
    if (this.#closed || this.#suspended || this.#storageError) return;
    const active = this.#data.runs.filter((run) => ACTIVE.has(run.status) || this.#stopping.has(run.id));
    const directories = new Set(active.map((run) => run.cwd));
    let count = active.length;
    const selected: AutomationRun[] = [];
    for (const run of this.#data.runs) {
      if (count >= 2) break;
      if (run.status !== "queued" || directories.has(run.cwd)) continue;
      run.status = "starting";
      run.startedAt = this.#iso();
      this.#accountedAt.set(run.id, this.now());
      directories.add(run.cwd);
      count++;
      selected.push(run);
    }
    if (!selected.length) return;
    // Durably claim occurrences BEFORE creating sessions or submitting prompts.
    try {
      await this.#persist();
    } catch (error) {
      for (const run of selected) {
        run.status = "queued";
        run.startedAt = undefined;
        this.#accountedAt.delete(run.id);
      }
      this.#emit();
      throw error;
    }
    for (const run of selected) {
      const controller = new AbortController();
      this.#controllers.set(run.id, controller);
      const launch = this.#launch(run, controller.signal);
      this.#launches.set(run.id, launch);
      void launch.finally(() => {
        this.#launches.delete(run.id);
      });
    }
  }

  async #launch(run: AutomationRun, signal: AbortSignal): Promise<void> {
    try {
      await this.executor.launch(
        structuredClone(run.config),
        structuredClone(run),
        async (sessionPath) => {
          await this.#exclusive(async () => {
            run.sessionPath = sessionPath;
            this.#data.origins[sessionPath] = { taskId: run.taskId, runId: run.id };
            await this.#persist();
          });
        },
        signal,
      );
      await this.#exclusive(async () => {
        if (run.status !== "starting") return;
        this.#account(run);
        run.status = "running";
        await this.#persist();
      });
    } catch (error) {
      await this.#exclusive(async () => {
        if (!ACTIVE.has(run.status)) return;
        this.#finish(run, "failed", error instanceof Error ? error.message : String(error));
        await this.#persist();
      }).catch(() => undefined);
    }
  }

  async observe(state: PiRuntimeState): Promise<void> {
    return this.#exclusive(async () => {
      const run = this.#data.runs.find((item) => item.sessionPath === state.sessionPath && ACTIVE.has(item.status));
      if (!run) return;
      this.#account(run);
      if (state.status === "error" || state.status === "exited") {
        this.#finish(run, "failed", state.error ?? "Pi exited before the run finished.");
      } else if (state.turnResult && !state.waitingUser) {
        const result = state.turnResult;
        this.#finish(
          run,
          result.status === "success" ? "success" : result.status === "cancelled" ? "cancelled" : "failed",
          result.error,
        );
      } else if (state.waitingUser) {
        const entering = run.status !== "waiting";
        run.status = "waiting";
        run.detail = state.waitingUser.detail ?? "Waiting for your approval or answer.";
        if (entering) this.executor.notify(structuredClone(run));
      } else if (run.status === "waiting") {
        run.status = "running";
        run.detail = undefined;
      } else return;
      await this.#persist();
    });
  }

  #finish(run: AutomationRun, status: AutomationRunStatus, detail?: string, notify = true): void {
    this.#account(run);
    run.status = status;
    run.detail = detail;
    run.finishedAt = this.#iso();
    this.#stopping.add(run.id);
    this.#controllers.get(run.id)?.abort();
    if (
      notify &&
      (status === "failed" || status === "timed_out" || (status === "success" && run.config.notifyOnSuccess))
    ) {
      this.executor.notify(structuredClone(run));
    }
    void this.#cleanup(run);
  }

  async #cleanup(run: AutomationRun): Promise<void> {
    try {
      if (run.sessionPath) await this.executor.stop(run.sessionPath, run.status);
      await this.#launches.get(run.id);
      if (run.sessionPath) await this.executor.stop(run.sessionPath, run.status);
    } catch (error) {
      this.#storageError = `Automations stopped: could not stop Pi. ${String(error)}`;
      this.#emit();
      return;
    }
    await this.#exclusive(async () => {
      this.#stopping.delete(run.id);
      this.#controllers.delete(run.id);
      this.#accountedAt.delete(run.id);
      await this.#persist();
      await this.#pump();
    }).catch(() => undefined);
  }

  async stop(runId: string): Promise<AutomationState> {
    return this.#exclusive(async () => {
      await this.#load();
      const run = this.#data.runs.find((item) => item.id === runId);
      if (!run || !OUTSTANDING.has(run.status)) throw new Error("This run has already ended.");
      if (run.status === "queued") {
        run.status = "cancelled";
        run.detail = "Stopped before execution.";
        run.finishedAt = this.#iso();
      } else this.#finish(run, "cancelled", "Stopped by you.");
      await this.#persist();
      return this.#snapshot();
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#exclusive(async () => {
      if (!this.#initialized) return;
      for (const run of this.#data.runs)
        if (ACTIVE.has(run.status)) {
          this.#finish(run, "failed", "E-Pi exited before this run finished.", false);
        }
      await this.#persist();
    });
    await Promise.allSettled([...this.#launches.values()]);
    await this.#chain;
  }
}
