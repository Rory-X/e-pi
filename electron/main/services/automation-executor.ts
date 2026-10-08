import { realpath, stat } from "node:fs/promises";

import { formatAutomationTime } from "../../../src/lib/automationSchedule";
import type { AutomationRun } from "../../../src/types/contracts";
import type { AutomationExecutor } from "./automation-service";
import type { ModelService } from "./model-service";
import type { PiRuntime } from "./pi-runtime";
import type { SessionService } from "./session-service";
import type { SkillService } from "./skill-service";

export function createAutomationExecutor(deps: {
  runtime: Pick<PiRuntime, "start" | "stop" | "submit" | "getStates" | "activeSessionPath">;
  sessions: Pick<SessionService, "create" | "rename">;
  models: Pick<ModelService, "list">;
  skills: Pick<SkillService, "list">;
  notify: (run: AutomationRun) => void;
  sessionsChanged: () => Promise<void>;
}): AutomationExecutor {
  return {
    async launch(config, run, attach, signal) {
      signal.throwIfAborted();
      const canonical = await realpath(config.cwd);
      if (canonical !== config.cwd || !(await stat(canonical)).isDirectory()) {
        throw new Error("The saved working directory moved or changed. Edit the task before running it again.");
      }
      const catalog = await deps.models.list(config.cwd);
      const model = catalog.providers
        .find((item) => item.id === config.model.provider)
        ?.models.find((item) => item.id === config.model.id && item.available);
      if (!model)
        throw new Error(
          `Saved model ${config.model.provider}/${config.model.id} is unavailable. Check Model settings.`,
        );
      if (config.skill) {
        const skill = (await deps.skills.list(config.cwd)).find(
          (item) => item.filePath === config.skill?.filePath && item.name === config.skill.name,
        );
        if (!skill) throw new Error(`Saved Skill ${config.skill.name} is no longer available in this directory.`);
      }
      signal.throwIfAborted();
      const session = await deps.sessions.create(config.cwd);
      await attach(session.path);
      await deps.sessions.rename(
        session.path,
        `${config.name} · ${formatAutomationTime(run.scheduledAt, config.timezone)}`,
        { automation: true },
      );
      await deps.sessionsChanged();
      signal.throwIfAborted();
      const abort = () => {
        void deps.runtime.stop(session.path).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await deps.runtime.start(session.path, config.cwd, {
          background: true,
          signal,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
        });
        signal.throwIfAborted();
        const actual = deps.runtime.getStates()[session.path];
        if (actual?.model?.provider !== config.model.provider || actual.model.id !== config.model.id) {
          throw new Error("Pi did not start with the task's saved model. The prompt was not submitted.");
        }
        if (actual.thinkingLevel !== config.thinkingLevel) {
          throw new Error("The saved thinking level is unsupported by this model. Edit the task's thinking level.");
        }
        deps.runtime.submit(
          session.path,
          config.skill ? `/skill:${config.skill.name} ${config.prompt}` : config.prompt,
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    stop: (path, reason) => {
      // A completed automation being viewed becomes an ordinary conversation.
      // Keep its editor usable; idle background processes can be released.
      if ((reason === "success" || reason === "failed") && deps.runtime.activeSessionPath === path) {
        return Promise.resolve();
      }
      return deps.runtime.stop(path);
    },
    notify: deps.notify,
  };
}
