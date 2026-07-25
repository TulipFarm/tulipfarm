import { describe, expect, it } from "vitest";
import type { BusinessCalendar } from "./calendar";
import {
  planSchedule,
  ScheduleError,
  type ScheduleSpec,
  type ScheduleState,
  scheduleSpecFromTrigger,
} from "./scheduler";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

const base: ScheduleSpec = {
  type: "datetime",
  timezone: NY,
  dstPolicy: "forward_only",
  missedRunPolicy: "skip",
  overlapPolicy: "allow",
  deduplicationKey: "trigger:daily-digest",
};

const idle: ScheduleState = { lastScheduledForMs: null, activeRuns: 0 };

function spec(extra: Partial<ScheduleSpec>): ScheduleSpec {
  return { ...base, ...extra };
}

describe("planSchedule — datetime", () => {
  const datetime = spec({ type: "datetime", at: "2026-07-25T10:00:00Z" });

  it("fires exactly once at the authored instant and has nothing due after it", () => {
    const plan = planSchedule(datetime, idle, at("2026-07-25T10:00:00Z"));

    expect(plan.fires).toEqual([
      {
        scheduledForMs: at("2026-07-25T10:00:00Z"),
        effectiveAtMs: at("2026-07-25T10:00:00Z"),
        deduplicationKey: `trigger:daily-digest:${at("2026-07-25T10:00:00Z")}`,
        catchUp: false,
        supersede: false,
      },
    ]);
    expect(plan.nextDueAtMs).toBeNull();
  });

  it("reports the pending instant without firing before it is due", () => {
    const plan = planSchedule(datetime, idle, at("2026-07-25T09:59:00Z"));

    expect(plan.fires).toEqual([]);
    expect(plan.nextDueAtMs).toBe(at("2026-07-25T10:00:00Z"));
  });

  it("never fires outside the authored start/end window", () => {
    const windowed = spec({ ...datetime, endAt: "2026-07-25T09:00:00Z" });
    const plan = planSchedule(windowed, idle, at("2026-07-25T11:00:00Z"));

    expect(plan.fires).toEqual([]);
    expect(plan.nextDueAtMs).toBeNull();
  });
});

describe("planSchedule — interval", () => {
  it("keeps a fixed UTC period across a DST transition instead of drifting an hour", () => {
    const hourly = spec({
      type: "interval",
      everyMs: 3_600_000,
      startAt: "2026-03-08T05:00:00Z",
      missedRunPolicy: "catch_up_bounded",
      catchUpCap: 10,
    });
    const plan = planSchedule(hourly, idle, at("2026-03-08T08:00:00Z"));

    expect(plan.fires.map((fire) => fire.scheduledForMs)).toEqual([
      at("2026-03-08T05:00:00Z"),
      at("2026-03-08T06:00:00Z"),
      at("2026-03-08T07:00:00Z"),
      at("2026-03-08T08:00:00Z"),
    ]);
  });

  it("refuses an interval with no anchor to count from", () => {
    expect(() => planSchedule(spec({ type: "interval", everyMs: 60_000 }), idle, 0)).toThrow(
      new ScheduleError("interval_anchor_missing", "trigger:daily-digest")
    );
  });
});

describe("planSchedule — cron", () => {
  const weekdayNine = spec({
    type: "cron",
    expression: "0 9 * * 1-5",
    missedRunPolicy: "catch_up_bounded",
    catchUpCap: 10,
  });

  it("holds the authored wall-clock hour on both sides of a DST change", () => {
    expect(planSchedule(weekdayNine, idle, at("2026-01-14T00:00:00Z")).nextDueAtMs).toBe(
      at("2026-01-14T14:00:00Z")
    );
    expect(planSchedule(weekdayNine, idle, at("2026-07-14T00:00:00Z")).nextDueAtMs).toBe(
      at("2026-07-14T13:00:00Z")
    );
  });

  it("skips weekends that the expression excludes", () => {
    // Friday 2026-07-24 09:00 local has already passed; the next match is Monday.
    expect(planSchedule(weekdayNine, idle, at("2026-07-24T14:00:00Z")).nextDueAtMs).toBe(
      at("2026-07-27T13:00:00Z")
    );
  });

  it("drops an occurrence the spring-forward gap erased when the policy says skip_missing", () => {
    const gap = spec({
      type: "cron",
      expression: "30 2 * * *",
      dstPolicy: "skip_missing",
      startAt: "2026-03-08T00:00:00Z",
    });

    // 02:30 local does not exist on 2026-03-08; the next real occurrence is the next day.
    expect(planSchedule(gap, idle, at("2026-03-08T00:00:00Z")).nextDueAtMs).toBe(
      at("2026-03-09T06:30:00Z")
    );
  });

  it("moves an erased occurrence to the end of the gap when the policy says forward_only", () => {
    const gap = spec({
      type: "cron",
      expression: "30 2 * * *",
      dstPolicy: "forward_only",
      startAt: "2026-03-08T00:00:00Z",
    });

    expect(planSchedule(gap, idle, at("2026-03-08T00:00:00Z")).nextDueAtMs).toBe(
      at("2026-03-08T07:00:00Z")
    );
  });

  it("fires a repeated fall-back hour once by default and twice under run_repeated", () => {
    const repeated = spec({
      type: "cron",
      expression: "30 1 * * *",
      startAt: "2026-11-01T00:00:00Z",
      missedRunPolicy: "catch_up_bounded",
      catchUpCap: 10,
    });
    const once = planSchedule(repeated, idle, at("2026-11-01T08:00:00Z"));
    const twice = planSchedule(
      { ...repeated, dstPolicy: "run_repeated" },
      idle,
      at("2026-11-01T08:00:00Z")
    );

    expect(once.fires.map((fire) => fire.scheduledForMs)).toEqual([at("2026-11-01T05:30:00Z")]);
    expect(twice.fires.map((fire) => fire.scheduledForMs)).toEqual([
      at("2026-11-01T05:30:00Z"),
      at("2026-11-01T06:30:00Z"),
    ]);
  });

  it("refuses a cron Trigger with no expression", () => {
    expect(() => planSchedule(spec({ type: "cron" }), idle, 0)).toThrow(
      new ScheduleError("cron_expression_missing", "trigger:daily-digest")
    );
  });

  it("refuses an unparseable cron expression", () => {
    expect(() => planSchedule(spec({ type: "cron", expression: "0 9 * *" }), idle, 0)).toThrow(
      new ScheduleError("cron_expression_invalid", "trigger:daily-digest")
    );
  });
});

describe("planSchedule — missed runs", () => {
  const minutely = (extra: Partial<ScheduleSpec>) =>
    spec({
      type: "interval",
      everyMs: 60_000,
      startAt: "2026-07-25T10:00:00Z",
      ...extra,
    });
  const state: ScheduleState = { lastScheduledForMs: at("2026-07-25T10:00:00Z"), activeRuns: 0 };
  const now = at("2026-07-25T10:05:00Z");

  it("runs only the current occurrence and counts the rest as skipped", () => {
    const plan = planSchedule(minutely({ missedRunPolicy: "skip" }), state, now);

    expect(plan.fires.map((fire) => fire.scheduledForMs)).toEqual([now]);
    expect(plan.fires[0]?.catchUp).toBe(false);
    expect(plan.skipped).toBe(4);
  });

  it("runs once for the whole missed window and marks that run as a catch-up", () => {
    const plan = planSchedule(minutely({ missedRunPolicy: "run_once" }), state, now);

    expect(plan.fires.map((fire) => fire.scheduledForMs)).toEqual([now]);
    expect(plan.fires[0]?.catchUp).toBe(true);
    expect(plan.skipped).toBe(4);
  });

  it("backfills at most catchUpCap occurrences, oldest first, and never more", () => {
    const plan = planSchedule(
      minutely({ missedRunPolicy: "catch_up_bounded", catchUpCap: 3 }),
      state,
      now
    );

    expect(plan.fires.map((fire) => fire.scheduledForMs)).toEqual([
      at("2026-07-25T10:03:00Z"),
      at("2026-07-25T10:04:00Z"),
      now,
    ]);
    expect(plan.fires.map((fire) => fire.catchUp)).toEqual([true, true, false]);
    expect(plan.skipped).toBe(2);
  });

  it("refuses catch_up_bounded without a bound", () => {
    expect(() =>
      planSchedule(minutely({ missedRunPolicy: "catch_up_bounded" }), state, now)
    ).toThrow(new ScheduleError("catch_up_cap_missing", "trigger:daily-digest"));
  });
});

describe("planSchedule — overlap", () => {
  const due = spec({ type: "datetime", at: "2026-07-25T10:00:00Z" });
  const now = at("2026-07-25T10:00:00Z");
  const busy: ScheduleState = { lastScheduledForMs: null, activeRuns: 1 };

  it("drops the occurrence while a Run is still in flight under skip", () => {
    const plan = planSchedule({ ...due, overlapPolicy: "skip" }, busy, now);

    expect(plan.fires).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it("starts alongside the in-flight Run under allow", () => {
    expect(planSchedule({ ...due, overlapPolicy: "allow" }, busy, now).fires).toHaveLength(1);
  });

  it("keeps only the newest occurrence and flags it under supersede", () => {
    const backlog = spec({
      type: "interval",
      everyMs: 60_000,
      startAt: "2026-07-25T10:00:00Z",
      missedRunPolicy: "catch_up_bounded",
      catchUpCap: 5,
      overlapPolicy: "supersede",
    });
    const plan = planSchedule(backlog, busy, at("2026-07-25T10:03:00Z"));

    expect(plan.fires.map((fire) => fire.scheduledForMs)).toEqual([at("2026-07-25T10:03:00Z")]);
    expect(plan.fires[0]?.supersede).toBe(true);
    expect(plan.skipped).toBe(3);
  });
});

describe("planSchedule — jitter and deduplication", () => {
  const jittered = spec({ type: "datetime", at: "2026-07-25T10:00:00Z", jitterMs: 60_000 });
  const now = at("2026-07-25T10:00:00Z");

  it("derives the same bounded offset for the same occurrence on every replan", () => {
    const first = planSchedule(jittered, idle, now).fires[0];
    const second = planSchedule(jittered, idle, now).fires[0];

    expect(first?.effectiveAtMs).toBe(second?.effectiveAtMs);
    expect(first?.effectiveAtMs).toBeGreaterThanOrEqual(now);
    expect(first?.effectiveAtMs).toBeLessThan(now + 60_000);
  });

  it("keys deduplication on the scheduled instant, not on the jittered one", () => {
    const fire = planSchedule(jittered, idle, now).fires[0];

    expect(fire?.deduplicationKey).toBe(`trigger:daily-digest:${now}`);
  });
});

describe("planSchedule — business calendar", () => {
  const calendar: BusinessCalendar = {
    id: "hq",
    timezone: NY,
    openWeekdays: [1, 2, 3, 4, 5],
    closedDates: ["2026-07-27"],
  };
  const daily = spec({
    type: "cron",
    expression: "0 9 * * *",
    startAt: "2026-07-24T00:00:00Z",
    calendar,
  });

  it("passes over occurrences that land while the business is closed", () => {
    // Saturday and Sunday are closed, and Monday 2026-07-27 is an explicit closed date.
    expect(planSchedule(daily, idle, at("2026-07-24T14:00:00Z")).nextDueAtMs).toBe(
      at("2026-07-28T13:00:00Z")
    );
  });
});

describe("scheduleSpecFromTrigger", () => {
  it("reads the schedule out of an authored Trigger, with fail-closed defaults", () => {
    expect(
      scheduleSpecFromTrigger({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Trigger",
        metadata: {
          id: "01J0000000000000000000TRIG",
          slug: "daily-digest",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          type: "cron",
          routineRef: { name: "digest", version: "1.0.0" },
          eventType: "schedule.due",
          eventVersion: 1,
          backgroundIdentity: { principalKind: "service", principalId: "scheduler" },
          deduplication: { key: "daily-digest", windowMs: 60_000 },
          expression: "0 9 * * 1-5",
          schedulePolicy: {
            timezone: NY,
            missedRunPolicy: "catch_up_bounded",
            catchUpCap: 3,
            overlapPolicy: "skip",
            jitterMs: 5_000,
          },
        },
      })
    ).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: NY,
      dstPolicy: "forward_only",
      missedRunPolicy: "catch_up_bounded",
      catchUpCap: 3,
      overlapPolicy: "skip",
      jitterMs: 5_000,
      deduplicationKey: "daily-digest",
    });
  });

  it("refuses a Trigger type that is not a schedule", () => {
    expect(() =>
      scheduleSpecFromTrigger({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Trigger",
        metadata: {
          id: "01J0000000000000000000TRIG",
          slug: "hook",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: {
          type: "webhook",
          routineRef: { name: "digest", version: "1.0.0" },
          eventType: "hook.received",
          eventVersion: 1,
          backgroundIdentity: { principalKind: "service", principalId: "scheduler" },
          deduplication: { key: "hook", windowMs: 60_000 },
        },
      })
    ).toThrow(new ScheduleError("not_a_schedule", "hook"));
  });
});
