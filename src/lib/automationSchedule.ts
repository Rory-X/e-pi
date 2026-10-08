import type { AutomationSchedule } from "../types/contracts";

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(at: number, timezone: string): number[] {
  const parts = formatter(timezone).formatToParts(at);
  return ["year", "month", "day", "hour", "minute", "second"].map((key) =>
    Number(parts.find((part) => part.type === key)?.value),
  );
}

function utcParts(parts: number[]): number {
  return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);
}

/** Earliest matching instant; undefined for a nonexistent DST local time. */
export function localDateTimeToUtc(value: string, timezone: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const wanted = value.split(/[-T:]/).map(Number);
  const naive = utcParts(wanted);
  const normalized = new Date(naive).toISOString().slice(0, 16);
  if (normalized !== value || wanted[0] < 1970) return undefined;
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((day) => {
      const probe = naive + day * DAY;
      return utcParts(localParts(probe, timezone)) - probe;
    }),
  );
  return [...offsets]
    .map((offset) => naive - offset)
    .filter((at) =>
      localParts(at, timezone)
        .slice(0, 5)
        .every((part, index) => part === wanted[index]),
    )
    .sort((a, b) => a - b)[0];
}

export function validateSchedule(schedule: AutomationSchedule, timezone: string): void {
  formatter(timezone).format(0);
  if (!schedule || typeof schedule !== "object") throw new Error("Choose a schedule.");
  if (schedule.kind === "once") {
    if (localDateTimeToUtc(schedule.localDateTime, timezone) === undefined) {
      throw new Error("Choose a valid date and time in the task's timezone.");
    }
  } else if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.every) ||
      schedule.every < 1 ||
      schedule.every > 100_000 ||
      !["minutes", "hours"].includes(schedule.unit) ||
      !Number.isFinite(Date.parse(schedule.anchor))
    ) {
      throw new Error("Intervals need a positive whole number and a valid start time.");
    }
  } else if (schedule.kind === "weekly") {
    if (
      !Array.isArray(schedule.weekdays) ||
      !schedule.weekdays.length ||
      schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)
    ) {
      throw new Error("Choose weekdays and a valid time.");
    }
  } else throw new Error("Unknown schedule type.");
}

function weeklyCandidates(
  schedule: Extract<AutomationSchedule, { kind: "weekly" }>,
  timezone: string,
  from: number,
  to: number,
): number[] {
  const start = utcParts(localParts(from, timezone).slice(0, 3));
  const end = utcParts(localParts(to, timezone).slice(0, 3));
  const result: number[] = [];
  for (let day = start; day <= end; day += DAY) {
    if (!schedule.weekdays.includes(new Date(day).getUTCDay())) continue;
    const local = `${new Date(day).toISOString().slice(0, 10)}T${schedule.time}`;
    const at = localDateTimeToUtc(local, timezone);
    if (at !== undefined && at >= from && at <= to) result.push(at);
  }
  return result;
}

/** Strictly after `after`; interval anchors are absolute instants. */
export function nextOccurrence(schedule: AutomationSchedule, timezone: string, after: number): number | undefined {
  if (schedule.kind === "once") {
    const at = localDateTimeToUtc(schedule.localDateTime, timezone);
    return at !== undefined && at > after ? at : undefined;
  }
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchor);
    const step = schedule.every * (schedule.unit === "minutes" ? 60_000 : 3_600_000);
    return anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step;
  }
  return weeklyCandidates(schedule, timezone, after + 1, after + 15 * DAY)[0];
}

export function dueOccurrences(
  schedule: AutomationSchedule,
  timezone: string,
  first: number,
  now: number,
): {
  latest: number;
  count: number;
  next?: number;
} {
  if (schedule.kind === "once") return { latest: first, count: 1 };
  if (schedule.kind === "interval") {
    const step = schedule.every * (schedule.unit === "minutes" ? 60_000 : 3_600_000);
    const count = Math.floor((now - first) / step) + 1;
    const latest = first + (count - 1) * step;
    return { latest, count, next: latest + step };
  }
  const occurrences = weeklyCandidates(schedule, timezone, first, now);
  return {
    latest: occurrences.at(-1) ?? first,
    count: Math.max(1, occurrences.length),
    next: nextOccurrence(schedule, timezone, now),
  };
}

export function formatAutomationTime(at: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}
