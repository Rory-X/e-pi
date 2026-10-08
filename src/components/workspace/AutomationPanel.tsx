import { Clock3, FolderOpen, History, LoaderCircle, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatAutomationTime, nextOccurrence, validateSchedule } from "@/lib/automationSchedule";
import { compactPath, pathBaseName } from "@/lib/format";
import type {
  AutomationInput,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationState,
  AutomationTask,
  ModelRecord,
  ModelRef,
  PiRuntimeState,
  Project,
  SkillRecord,
} from "@/types/contracts";

interface AutomationPanelProps {
  open: boolean;
  cwd: string;
  projects: Project[];
  runtime?: PiRuntimeState;
  onOpenChange: (open: boolean) => void;
  onOpenSession: (path: string) => Promise<void>;
}

const OUTSTANDING = new Set<AutomationRunStatus>(["queued", "starting", "running", "waiting"]);
const STATUS: Record<AutomationRunStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Needs input",
  success: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  timed_out: "Timed out",
  skipped: "Skipped",
  missed: "Missed",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Choice({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") return "One time";
  if (schedule.kind === "interval") return `Every ${schedule.every} ${schedule.unit}`;
  return `${schedule.weekdays.map((day) => DAYS[day]).join(", ")} · ${schedule.time}`;
}
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function nextLabel(task: AutomationTask): string {
  return task.deletedAt
    ? "Deleted"
    : !task.enabled
      ? "Paused"
      : task.nextRunAt
        ? `Next: ${formatAutomationTime(task.nextRunAt, task.timezone)}`
        : "Schedule completed";
}

export function AutomationPanel({ open, cwd, projects, runtime, onOpenChange, onOpenSession }: AutomationPanelProps) {
  const [state, setState] = useState<AutomationState>({ tasks: [], runs: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [historyId, setHistoryId] = useState<string>();
  const historyRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (historyId) historyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [historyId]);
  const [editor, setEditor] = useState<AutomationTask | "new">();
  const [removeTarget, setRemoveTarget] = useState<AutomationTask>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const update = (value: AutomationState) => {
      if (!cancelled) setState(value);
    };
    const unsubscribe = window.ePi.automations.onUpdated(update);
    void window.ePi.automations
      .list()
      .then(update)
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  const act = async (action: () => Promise<AutomationState>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await action());
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const directories = useMemo(() => [...new Set(state.tasks.map((task) => task.cwd))], [state.tasks]);
  const filters = [
    { value: "all", label: "All projects" },
    ...projects.map((project) => ({ value: project.id, label: project.name || pathBaseName(project.primaryRepo) })),
    ...directories
      .filter((dir) => !projects.some((project) => project.folders.includes(dir)))
      .map((dir) => ({ value: dir, label: pathBaseName(dir) })),
  ];
  const selectedProject = projects.find((project) => project.id === filter);
  const visibleTasks = state.tasks.filter(
    (task) =>
      !task.deletedAt &&
      (filter === "all" || (selectedProject ? selectedProject.folders.includes(task.cwd) : task.cwd === filter)) &&
      `${task.name} ${task.prompt} ${task.cwd}`.toLowerCase().includes(query.toLowerCase()),
  );
  const deletedTasks = state.tasks.filter((task) => task.deletedAt);
  const historyTask = state.tasks.find((task) => task.id === historyId);
  const history = state.runs.filter((run) => run.taskId === historyId).toReversed();
  const waiting = state.runs.filter((run) => run.status === "waiting");
  const openSession = async (path: string) => {
    try {
      await onOpenSession(path);
      onOpenChange(false);
    } catch (reason) {
      toast.error(`Could not open this session: ${String(reason)}`);
    }
  };
  const runRow = (run: AutomationRun) => (
    <div className="automation-run" key={run.id}>
      <div className="automation-run-heading">
        <Badge variant="outline" data-status={run.status}>
          {STATUS[run.status]}
        </Badge>
        <time dateTime={run.scheduledAt}>{formatAutomationTime(run.scheduledAt, run.timezone)}</time>
        <span>{run.trigger === "manual" ? "Manual" : "Scheduled"}</span>
      </div>
      <div className="automation-run-meta">
        {run.startedAt
          ? `Started ${formatAutomationTime(run.startedAt, run.timezone)} · Active ${duration(run.elapsedMs)}`
          : "Not started"}
        {run.finishedAt ? ` · Ended ${formatAutomationTime(run.finishedAt, run.timezone)}` : ""}
      </div>
      {run.detail ? <p className="automation-run-detail">{run.detail}</p> : null}
      <div className="automation-actions">
        {run.sessionPath ? (
          <Button size="sm" variant="outline" onClick={() => void openSession(run.sessionPath!)}>
            {run.status === "waiting" ? "Review and continue" : "Open session"}
          </Button>
        ) : null}
        {OUTSTANDING.has(run.status) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(() => window.ePi.automations.stop(run.id))}
          >
            <Square size={13} />
            Stop
          </Button>
        ) : null}
        {!OUTSTANDING.has(run.status) && !historyTask?.deletedAt ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || state.runs.some((item) => item.taskId === run.taskId && OUTSTANDING.has(item.status))}
            onClick={() => void act(() => window.ePi.automations.runNow(run.taskId))}
          >
            <Play size={13} />
            Run again
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="automation-drawer" aria-describedby="automation-description">
        <div className="automation-heading">
          <Clock3 size={20} />
          <SheetTitle>Automations</SheetTitle>
        </div>
        <SheetDescription id="automation-description">Schedule Pi tasks while E-Pi is running.</SheetDescription>
        <div className="automation-toolbar">
          <Button size="sm" onClick={() => setEditor("new")}>
            <Plus size={14} />
            New task
          </Button>
          <Choice value={filter} onChange={setFilter} options={filters} label="Filter by project" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search automations"
            placeholder="Search tasks"
          />
        </div>
        {error || state.error ? (
          <div className="inline-error" role="alert">
            {error || state.error}
          </div>
        ) : null}
        <div className="automation-body">
          {waiting.length ? (
            <div className="automation-waiting" role="status">
              <strong>
                {waiting.length} {waiting.length === 1 ? "run needs" : "runs need"} your input
              </strong>
              <p>Waiting runs keep their directory and execution slot. Open a session to continue, or stop it.</p>
              {waiting.map((run) => (
                <Button
                  key={run.id}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setHistoryId(run.taskId);
                    if (run.sessionPath) void openSession(run.sessionPath);
                  }}
                >
                  {run.taskName}
                </Button>
              ))}
            </div>
          ) : null}
          {loading ? (
            <div className="automation-empty">
              <LoaderCircle size={16} className="spin" />
              Loading tasks…
            </div>
          ) : visibleTasks.length === 0 ? (
            <div className="automation-empty">
              {state.tasks.some((task) => !task.deletedAt)
                ? "No matching tasks"
                : "Create a task to run Pi on a schedule."}
            </div>
          ) : null}
          {visibleTasks.map((task) => {
            const active = state.runs.find((run) => run.taskId === task.id && OUTSTANDING.has(run.status));
            const last = state.runs.findLast((run) => run.taskId === task.id);
            return (
              <article className="automation-card" key={task.id}>
                <div className="automation-card-heading">
                  <strong>{task.name}</strong>
                  {active || last ? (
                    <Badge variant="outline" data-status={(active || last)!.status}>
                      {STATUS[(active || last)!.status]}
                    </Badge>
                  ) : null}
                  {!task.enabled ? <Badge variant="secondary">Paused</Badge> : null}
                </div>
                <p className="automation-prompt">{task.prompt}</p>
                <p className="automation-meta" title={task.cwd}>
                  {compactPath(task.cwd, 65)}
                </p>
                <p className="automation-meta">
                  {scheduleLabel(task.schedule)} · {task.timezone}
                </p>
                <p className="automation-next">{nextLabel(task)}</p>
                <div className="automation-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || Boolean(active)}
                    onClick={() => void act(() => window.ePi.automations.runNow(task.id))}
                  >
                    <Play size={13} />
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => window.ePi.automations.setEnabled(task.id, !task.enabled))}
                  >
                    {task.enabled ? <Pause size={13} /> : <Play size={13} />}
                    {task.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditor(task)}>
                    <Pencil size={13} />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistoryId(historyId === task.id ? undefined : task.id)}
                  >
                    <History size={13} />
                    History
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Delete ${task.name}`}
                    onClick={() => setRemoveTarget(task)}
                  >
                    <Trash2 size={13} />
                  </Button>
                  {active ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(() => window.ePi.automations.stop(active.id))}
                    >
                      <Square size={13} />
                      Stop
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
          {deletedTasks.length ? (
            <details className="automation-deleted">
              <summary>Deleted tasks · retained history</summary>
              {deletedTasks.map((task) => (
                <Button key={task.id} variant="ghost" size="sm" onClick={() => setHistoryId(task.id)}>
                  <History size={13} />
                  {task.name}
                </Button>
              ))}
            </details>
          ) : null}
          {historyTask ? (
            <section ref={historyRef} className="automation-history" aria-label="Run history">
              <div className="automation-card-heading">
                <h3>{historyTask.name} · History</h3>
                <Button size="sm" variant="ghost" onClick={() => setHistoryId(undefined)}>
                  Close
                </Button>
              </div>
              <p className="automation-meta">Latest 100 records, plus outstanding runs. Pi sessions are kept.</p>
              {history.length ? history.map(runRow) : <p className="automation-empty">No runs yet.</p>}
            </section>
          ) : null}
        </div>
        <p className="automation-footer">
          Up to 2 runs at once · Same directory runs in sequence · Latest missed run catches up
        </p>
        {editor ? (
          <AutomationEditor
            task={editor === "new" ? undefined : editor}
            cwd={cwd}
            runtime={runtime}
            onClose={() => setEditor(undefined)}
            onSave={async (input) => {
              const saved = await act(() =>
                window.ePi.automations.save({ id: editor === "new" ? undefined : editor.id, input }),
              );
              if (saved) {
                setEditor(undefined);
                toast.success("Automation saved");
              }
            }}
            busy={busy}
          />
        ) : null}
        <AlertDialog
          open={Boolean(removeTarget)}
          onOpenChange={(value) => {
            if (!value) setRemoveTarget(undefined);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {removeTarget?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Queued and future runs will be cancelled. A current run will continue. History and Pi sessions will be
                kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={() => {
                  if (removeTarget) void act(() => window.ePi.automations.remove(removeTarget.id));
                }}
              >
                Delete task
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

function initialDraft(task: AutomationTask | undefined, cwd: string, runtime?: PiRuntimeState): AutomationInput {
  if (task) return structuredClone(task);
  return {
    name: "",
    prompt: "",
    cwd,
    model: runtime?.model ?? { provider: "", id: "" },
    thinkingLevel: runtime?.thinkingLevel ?? "off",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    schedule: { kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" },
    timeoutMinutes: 60,
    notifyOnSuccess: false,
  };
}

function AutomationEditor({
  task,
  cwd,
  runtime,
  onClose,
  onSave,
  busy,
}: {
  task?: AutomationTask;
  cwd: string;
  runtime?: PiRuntimeState;
  onClose: () => void;
  onSave: (input: AutomationInput) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(() => initialDraft(task, cwd, runtime));
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [resourceError, setResourceError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setResourcesLoading(true);
    setResourceError(undefined);
    setModels([]);
    setSkills([]);
    if (!draft.cwd.trim()) {
      setResourcesLoading(false);
      return;
    }
    // Debounce directory typing; stale results cannot replace a newer directory's catalog.
    const timer = setTimeout(() => {
      void Promise.all([
        window.ePi.models.list(draft.cwd),
        window.ePi.skills.list(draft.cwd),
        window.ePi.agent.getConfig(),
      ])
        .then(([catalog, loadedSkills, agentConfig]) => {
          if (cancelled) return;
          const available = catalog.providers.flatMap((provider) => provider.models).filter((model) => model.available);
          setModels(available);
          setSkills(loadedSkills);
          if (catalog.error) setResourceError(catalog.error);
          setDraft((current) => {
            if (current.model.id) return current;
            const chosen =
              available.find(
                (model) => model.provider === catalog.defaultModel?.provider && model.id === catalog.defaultModel.id,
              ) ?? available[0];
            return chosen
              ? {
                  ...current,
                  model: { provider: chosen.provider, id: chosen.id },
                  thinkingLevel: chosen.supportedThinkingLevels?.includes(
                    agentConfig.thinkingLevel as AutomationInput["thinkingLevel"],
                  )
                    ? (agentConfig.thinkingLevel as AutomationInput["thinkingLevel"])
                    : chosen.supportedThinkingLevels?.includes(catalog.defaultThinkingLevel ?? "off")
                      ? (catalog.defaultThinkingLevel ?? "off")
                      : "off",
                }
              : current;
          });
        })
        .catch((reason) => {
          if (!cancelled) setResourceError(String(reason));
        })
        .finally(() => {
          if (!cancelled) setResourcesLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.cwd]);
  const patch = <K extends keyof AutomationInput>(key: K, value: AutomationInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const selectedModel = models.find((model) => model.provider === draft.model.provider && model.id === draft.model.id);
  const levels =
    selectedModel?.supportedThinkingLevels ??
    (selectedModel?.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"]);
  const effectiveSchedule = useMemo(() => {
    if (draft.schedule.kind !== "interval") return draft.schedule;
    const same =
      task?.schedule.kind === "interval" &&
      task.schedule.every === draft.schedule.every &&
      task.schedule.unit === draft.schedule.unit;
    return same
      ? task.schedule
      : {
          ...draft.schedule,
          anchor: new Date(
            now + draft.schedule.every * (draft.schedule.unit === "minutes" ? 60_000 : 3_600_000),
          ).toISOString(),
        };
  }, [draft.schedule, now, task]);
  let preview: string | undefined;
  let scheduleError: string | undefined;
  try {
    validateSchedule(effectiveSchedule, draft.timezone);
    const unchanged =
      task && JSON.stringify(task.schedule) === JSON.stringify(effectiveSchedule) && task.timezone === draft.timezone;
    const next =
      unchanged && task.nextRunAt ? Date.parse(task.nextRunAt) : nextOccurrence(effectiveSchedule, draft.timezone, now);
    if (next !== undefined) preview = formatAutomationTime(new Date(next).toISOString(), draft.timezone);
    else if (!unchanged) scheduleError = "Choose a future date and time.";
  } catch (reason) {
    scheduleError = reason instanceof Error ? reason.message : String(reason);
  }
  const valid =
    draft.name.trim() &&
    draft.prompt.trim() &&
    draft.cwd.trim() &&
    selectedModel &&
    levels.includes(draft.thinkingLevel) &&
    !resourcesLoading &&
    !scheduleError &&
    Number.isInteger(draft.timeoutMinutes) &&
    draft.timeoutMinutes >= 1 &&
    draft.timeoutMinutes <= 10_080 &&
    (!draft.skill ||
      skills.some((skill) => skill.filePath === draft.skill?.filePath && skill.name === draft.skill.name));
  const modelKey = (ref: ModelRef) => JSON.stringify({ provider: ref.provider, id: ref.id });
  const modelOptions = models.map((model) => ({ value: modelKey(model), label: `${model.name} · ${model.provider}` }));
  if (draft.model.id && !selectedModel)
    modelOptions.unshift({
      value: modelKey(draft.model),
      label: `${draft.model.provider}/${draft.model.id} (unavailable)`,
    });
  const skillOptions = [
    { value: "none", label: "No Skill" },
    ...skills.map((skill) => ({ value: skill.filePath, label: skill.name })),
  ];
  if (draft.skill && !skills.some((skill) => skill.filePath === draft.skill?.filePath)) {
    skillOptions.push({ value: draft.skill.filePath, label: `${draft.skill.name} (unavailable)` });
  }
  const changeKind = (kind: string) => {
    if (kind === "once") patch("schedule", { kind: "once", localDateTime: "" });
    else if (kind === "interval")
      patch("schedule", { kind: "interval", every: 1, unit: "hours", anchor: new Date(now + 3_600_000).toISOString() });
    else patch("schedule", { kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" });
  };

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent className="automation-editor" aria-describedby="automation-editor-description">
        <DialogHeader>
          <DialogTitle>{task ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription id="automation-editor-description">
            Each run starts a new Pi session. Edits apply to future runs.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !busy) void onSave({ ...draft, schedule: effectiveSchedule });
          }}
        >
          <fieldset disabled={busy} className="automation-fields">
            <label>
              Name
              <Input
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => patch("name", event.target.value)}
                placeholder="Daily project review"
              />
            </label>
            <label>
              Prompt
              <Textarea
                required
                rows={4}
                value={draft.prompt}
                onChange={(event) => patch("prompt", event.target.value)}
                placeholder="Describe what Pi should do and what result you want."
              />
            </label>
            <label>
              Working directory
              <div className="automation-directory">
                <Input required value={draft.cwd} onChange={(event) => patch("cwd", event.target.value)} />
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Choose working directory"
                  onClick={() => {
                    void window.ePi.app.chooseDirectory(draft.cwd).then((dir) => {
                      if (dir) patch("cwd", dir);
                    });
                  }}
                >
                  <FolderOpen size={15} />
                </Button>
              </div>
            </label>
            <label>
              Skill (optional)
              <Choice
                label="Skill"
                value={draft.skill?.filePath ?? "none"}
                options={skillOptions}
                disabled={resourcesLoading}
                onChange={(path) => {
                  const skill = skills.find((item) => item.filePath === path);
                  patch("skill", skill ? { name: skill.name, filePath: skill.filePath } : undefined);
                }}
              />
            </label>
            <div className="automation-field-pair">
              <label>
                Model
                <Choice
                  label="Model"
                  value={draft.model.id ? modelKey(draft.model) : ""}
                  options={modelOptions}
                  disabled={resourcesLoading}
                  onChange={(key) => {
                    const chosen = models.find((model) => modelKey(model) === key);
                    if (chosen)
                      setDraft((current) => ({
                        ...current,
                        model: { provider: chosen.provider, id: chosen.id },
                        thinkingLevel: chosen.supportedThinkingLevels?.includes(current.thinkingLevel)
                          ? current.thinkingLevel
                          : chosen.reasoning
                            ? "high"
                            : "off",
                      }));
                  }}
                />
              </label>
              <label>
                Thinking level
                <Choice
                  label="Thinking level"
                  value={draft.thinkingLevel}
                  options={[...new Set([...levels, draft.thinkingLevel])].map((level) => ({
                    value: level,
                    label: level,
                  }))}
                  onChange={(level) => patch("thinkingLevel", level as AutomationInput["thinkingLevel"])}
                />
              </label>
            </div>
            {resourcesLoading ? (
              <p className="automation-meta">Loading models and Skills…</p>
            ) : resourceError ? (
              <p className="inline-error" role="alert">
                {resourceError}
              </p>
            ) : !models.length ? (
              <p className="inline-error">Configure an available model in Settings first.</p>
            ) : null}
            <div className="automation-field-pair">
              <label>
                Schedule
                <Choice
                  label="Schedule"
                  value={draft.schedule.kind}
                  onChange={changeKind}
                  options={[
                    { value: "once", label: "One time" },
                    { value: "interval", label: "Every N minutes / hours" },
                    { value: "weekly", label: "Days of the week" },
                  ]}
                />
              </label>
              <label>
                Timezone
                <Input
                  required
                  value={draft.timezone}
                  onChange={(event) => patch("timezone", event.target.value)}
                  placeholder="Asia/Shanghai"
                  list="automation-timezones"
                />
                <datalist id="automation-timezones">
                  {[
                    ...new Set([
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                      "Asia/Shanghai",
                      "Asia/Tokyo",
                      "UTC",
                      "Europe/London",
                      "America/New_York",
                      "America/Los_Angeles",
                    ]),
                  ].map((zone) => (
                    <option value={zone} key={zone} />
                  ))}
                </datalist>
              </label>
            </div>
            {draft.schedule.kind === "once" ? (
              <label>
                Date and time in {draft.timezone}
                <Input
                  type="datetime-local"
                  required
                  value={draft.schedule.localDateTime}
                  onChange={(event) => patch("schedule", { kind: "once", localDateTime: event.target.value })}
                />
              </label>
            ) : null}
            {draft.schedule.kind === "interval" ? (
              <div className="automation-field-pair">
                <label>
                  Every
                  <Input
                    type="number"
                    required
                    min={1}
                    max={100000}
                    value={draft.schedule.every}
                    onChange={(event) => {
                      if (draft.schedule.kind === "interval")
                        patch("schedule", { ...draft.schedule, every: Number(event.target.value) });
                    }}
                  />
                </label>
                <label>
                  Unit
                  <Choice
                    label="Interval unit"
                    value={draft.schedule.unit}
                    options={[
                      { value: "minutes", label: "Minutes" },
                      { value: "hours", label: "Hours" },
                    ]}
                    onChange={(unit) => {
                      if (draft.schedule.kind === "interval")
                        patch("schedule", { ...draft.schedule, unit: unit as "minutes" | "hours" });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {draft.schedule.kind === "weekly" ? (
              <>
                <div className="automation-weekdays" role="group" aria-label="Weekdays">
                  {DAYS.map((day, index) => {
                    const schedule = draft.schedule;
                    if (schedule.kind !== "weekly") return null;
                    const checked = schedule.weekdays.includes(index);
                    return (
                      <Button
                        key={day}
                        type="button"
                        size="sm"
                        variant={checked ? "default" : "outline"}
                        aria-pressed={checked}
                        onClick={() =>
                          patch("schedule", {
                            ...schedule,
                            weekdays: checked
                              ? schedule.weekdays.filter((value) => value !== index)
                              : [...schedule.weekdays, index].sort(),
                          })
                        }
                      >
                        {day}
                      </Button>
                    );
                  })}
                </div>
                <label>
                  Time in {draft.timezone}
                  <Input
                    type="time"
                    required
                    value={draft.schedule.time}
                    onChange={(event) => {
                      if (draft.schedule.kind === "weekly")
                        patch("schedule", { ...draft.schedule, time: event.target.value });
                    }}
                  />
                </label>
              </>
            ) : null}
            <p className="automation-preview" role="status">
              {scheduleError ||
                (preview
                  ? `Next run: ${preview} · ${draft.timezone}`
                  : "Schedule completed; Run now remains available.")}
            </p>
            <label>
              Timeout (minutes)
              <Input
                type="number"
                required
                min={1}
                max={10080}
                value={draft.timeoutMinutes}
                onChange={(event) => patch("timeoutMinutes", Number(event.target.value))}
              />
              <span className="automation-meta">Waiting for your input does not count toward the timeout.</span>
            </label>
            <label className="automation-notification">
              <Checkbox
                checked={draft.notifyOnSuccess}
                onCheckedChange={(value) => patch("notifyOnSuccess", value === true)}
              />
              Notify on successful completion
            </label>
            <p className="automation-meta">Failures, timeouts and requests for your input always notify.</p>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? <LoaderCircle size={14} className="spin" /> : null}Save task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
