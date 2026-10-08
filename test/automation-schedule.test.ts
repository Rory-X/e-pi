import { describe, expect, it } from "vitest";

import { dueOccurrences, localDateTimeToUtc, nextOccurrence, validateSchedule } from "../src/lib/automationSchedule";

const at = Date.parse;
describe("automation schedules", () => {
  it("interprets one-time dates in the saved timezone, independently of host timezone", () => {
    const schedule = { kind: "once", localDateTime: "2026-10-06T09:00" } as const;
    expect(nextOccurrence(schedule, "Asia/Shanghai", at("2026-10-05T12:00Z"))).toBe(at("2026-10-06T01:00Z"));
    expect(nextOccurrence(schedule, "Asia/Shanghai", at("2026-10-06T01:00Z"))).toBeUndefined();
    expect(localDateTimeToUtc("2026-02-30T09:00", "UTC")).toBeUndefined();
  });
  it("keeps interval anchors and catches up just the latest occurrence", () => {
    const schedule = { kind: "interval", every: 2, unit: "hours", anchor: "2026-10-01T00:00Z" } as const;
    expect(nextOccurrence(schedule, "UTC", at("2026-10-01T00:01Z"))).toBe(at("2026-10-01T02:00Z"));
    expect(dueOccurrences(schedule, "UTC", at("2026-10-01T02:00Z"), at("2026-10-01T09:23Z"))).toEqual({
      latest: at("2026-10-01T08:00Z"),
      count: 4,
      next: at("2026-10-01T10:00Z"),
    });
  });
  it("selects weekdays at a fixed local time and treats the boundary exclusively", () => {
    const schedule = { kind: "weekly", weekdays: [1, 3, 5], time: "09:00" };
    expect(nextOccurrence(schedule as never, "Asia/Shanghai", at("2026-10-05T01:00Z"))).toBe(at("2026-10-07T01:00Z"));
  });
  it("runs a repeated DST local time once, at its first occurrence", () => {
    const schedule = { kind: "weekly", weekdays: [0], time: "01:30" } as const;
    expect(localDateTimeToUtc("2026-11-01T01:30", "America/New_York")).toBe(at("2026-11-01T05:30Z"));
    expect(
      nextOccurrence({ ...schedule, weekdays: [...schedule.weekdays] }, "America/New_York", at("2026-11-01T05:31Z")),
    ).toBe(at("2026-11-08T06:30Z"));
  });
  it("skips nonexistent DST times and resumes on the next selected day", () => {
    expect(localDateTimeToUtc("2026-03-08T02:30", "America/New_York")).toBeUndefined();
    expect(
      nextOccurrence({ kind: "weekly", weekdays: [0], time: "02:30" }, "America/New_York", at("2026-03-07T00:00Z")),
    ).toBe(at("2026-03-15T06:30Z"));
  });
  it("counts missed weekly occurrences without changing the future schedule", () => {
    const schedule = { kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" } as const;
    expect(
      dueOccurrences(
        { ...schedule, weekdays: [...schedule.weekdays] },
        "Asia/Shanghai",
        at("2026-10-05T01:00Z"),
        at("2026-10-08T02:00Z"),
      ),
    ).toEqual({ latest: at("2026-10-08T01:00Z"), count: 4, next: at("2026-10-09T01:00Z") });
  });
  it("rejects invalid schedule inputs", () => {
    expect(() => validateSchedule({ kind: "weekly", weekdays: [], time: "09:00" }, "UTC")).toThrow("weekdays");
    expect(() => validateSchedule({ kind: "weekly", weekdays: [7], time: "09:00" }, "UTC")).toThrow("weekdays");
    expect(() => validateSchedule({ kind: "weekly", weekdays: [1], time: "24:01" }, "UTC")).toThrow("weekdays");
    expect(() => validateSchedule({ kind: "interval", every: 0, unit: "hours", anchor: "2026-10-01" }, "UTC")).toThrow(
      "Intervals",
    );
    expect(() => validateSchedule({ kind: "once", localDateTime: "2026-10-05T12:00" }, "bad/timezone")).toThrow(
      "time zone",
    );
  });
});
