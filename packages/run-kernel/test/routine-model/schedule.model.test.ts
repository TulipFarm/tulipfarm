import { describe, expect, it } from "vitest";
import {
  localPartsAt,
  type MissedRunPolicy,
  type OverlapPolicy,
  planSchedule,
  type ScheduleSpec,
  type ScheduleState,
} from "../../src/triggers";
import { forEachCase, intBetween, pick } from "./support";

/**
 * Reference model for SPEC §9.2 scheduling.
 *
 * Interval occurrences are a closed form — `anchor + k * period` — so the model can enumerate them
 * independently and the planner's output is checked against that enumeration rather than against a
 * remembered fixture. Calendar schedules are checked on the property that actually matters across
 * a DST transition: the *local wall clock* the author wrote, not the elapsed UTC time.
 */

const MISSED_POLICIES: readonly MissedRunPolicy[] = ["skip", "run_once", "catch_up_bounded"];
const OVERLAP_POLICIES: readonly OverlapPolicy[] = ["skip", "allow", "supersede"];

const ANCHOR_MS = Date.UTC(2026, 6, 1, 0, 0, 0);

interface Case {
  readonly spec: ScheduleSpec;
  readonly state: ScheduleState;
  readonly nowMs: number;
  /** Every occurrence the model says is due, oldest first. */
  readonly due: readonly number[];
}

function intervalCase(random: () => number): Case {
  const everyMs = intBetween(random, 1, 12) * 60_000;
  const elapsed = intBetween(random, 0, 20);
  const nowMs = ANCHOR_MS + elapsed * everyMs + intBetween(random, 0, everyMs - 1);
  const missedRunPolicy = pick(random, MISSED_POLICIES);
  const catchUpCap = intBetween(random, 1, 5);
  const hasFired = random() < 0.5 && elapsed > 0;
  const lastScheduledForMs = hasFired
    ? ANCHOR_MS + intBetween(random, 0, elapsed - 1) * everyMs
    : null;

  const spec: ScheduleSpec = {
    type: "interval",
    everyMs,
    timezone: "UTC",
    dstPolicy: "forward_only",
    missedRunPolicy,
    catchUpCap,
    overlapPolicy: pick(random, OVERLAP_POLICIES),
    jitterMs: random() < 0.5 ? intBetween(random, 1, 30_000) : undefined,
    startAt: new Date(ANCHOR_MS).toISOString(),
    deduplicationKey: "digest-trigger",
  };
  const state: ScheduleState = {
    lastScheduledForMs,
    activeRuns: random() < 0.5 ? 0 : intBetween(random, 1, 3),
  };

  const from = lastScheduledForMs ?? ANCHOR_MS - 1;
  const due: number[] = [];
  for (let instant = ANCHOR_MS; instant <= nowMs; instant += everyMs) {
    if (instant > from) due.push(instant);
  }

  return { spec, state, nowMs, due };
}

describe("interval schedules match the reference enumeration", () => {
  it("only ever fires occurrences the model says are due", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs, due } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);

      for (const fire of plan.fires) {
        expect(due).toContain(fire.scheduledForMs);
        expect(fire.scheduledForMs).toBeLessThanOrEqual(nowMs);
        if (state.lastScheduledForMs !== null) {
          expect(fire.scheduledForMs).toBeGreaterThan(state.lastScheduledForMs);
        }
      }
    });
  });

  it("accounts for every due occurrence as either fired or skipped", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs, due } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);

      expect(plan.fires.length + plan.skipped).toBe(due.length);
    });
  });

  it("honours the missed-run policy's fire budget", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);

      const budget = spec.missedRunPolicy === "catch_up_bounded" ? (spec.catchUpCap as number) : 1;
      expect(plan.fires.length).toBeLessThanOrEqual(budget);
    });
  });

  it("backfills oldest-first and ends on the current occurrence", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs, due } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);
      if (plan.fires.length === 0) return;

      const fired = plan.fires.map((fire) => fire.scheduledForMs);
      expect([...fired].sort((a, b) => a - b)).toEqual(fired);
      if (spec.overlapPolicy !== "supersede" || state.activeRuns === 0) {
        expect(fired.at(-1)).toBe(due.at(-1));
      }
      expect(plan.fires.filter((fire) => !fire.catchUp).length).toBeLessThanOrEqual(1);
    });
  });

  it("applies the overlap policy against in-flight Runs", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);
      if (state.activeRuns === 0) return;

      if (spec.overlapPolicy === "skip") expect(plan.fires).toHaveLength(0);
      if (spec.overlapPolicy === "supersede") {
        expect(plan.fires.length).toBeLessThanOrEqual(1);
        expect(plan.fires.every((fire) => fire.supersede)).toBe(true);
      }
    });
  });

  it("keeps jitter bounded, deterministic, and inside the occurrence's identity", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs } = intervalCase(random);
      const plan = planSchedule(spec, state, nowMs);
      const replanned = planSchedule(spec, state, nowMs);

      expect(replanned).toEqual(plan);
      for (const fire of plan.fires) {
        const jitter = fire.effectiveAtMs - fire.scheduledForMs;
        expect(jitter).toBeGreaterThanOrEqual(0);
        expect(jitter).toBeLessThan(spec.jitterMs ?? 1);
        expect(fire.deduplicationKey).toBe(`${spec.deduplicationKey}:${fire.scheduledForMs}`);
      }
    });
  });

  it("gives every planned occurrence a distinct deduplication key", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs } = intervalCase(random);
      const keys = planSchedule(spec, state, nowMs).fires.map((fire) => fire.deduplicationKey);

      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  it("always points at a future occurrence for an open-ended schedule", () => {
    forEachCase(80, (random) => {
      const { spec, state, nowMs } = intervalCase(random);
      const { nextDueAtMs } = planSchedule(spec, state, nowMs);

      expect(nextDueAtMs).not.toBeNull();
      expect(nextDueAtMs as number).toBeGreaterThan(nowMs);
    });
  });
});

describe("cron schedules keep authored wall-clock time across DST", () => {
  const TZ = "America/New_York";

  function cron(expression: string, overrides: Partial<ScheduleSpec> = {}): ScheduleSpec {
    return {
      type: "cron",
      expression,
      timezone: TZ,
      dstPolicy: "skip_missing",
      missedRunPolicy: "catch_up_bounded",
      catchUpCap: 10,
      overlapPolicy: "allow",
      deduplicationKey: "digest-trigger",
      ...overrides,
    };
  }

  it("fires at the authored local hour on every day spanning a spring-forward", () => {
    // 2027-03-14 is the US spring-forward; 12:00 local exists on every day in the window.
    const spec = cron("0 12 * * *");
    let cursor = Date.UTC(2027, 2, 10, 0, 0, 0);
    const end = Date.UTC(2027, 2, 20, 0, 0, 0);
    const fired: number[] = [];

    while (cursor < end) {
      const plan = planSchedule(
        spec,
        { lastScheduledForMs: fired.at(-1) ?? null, activeRuns: 0 },
        cursor
      );
      for (const fire of plan.fires) fired.push(fire.scheduledForMs);
      cursor += 6 * 3_600_000;
    }

    expect(fired.length).toBeGreaterThanOrEqual(9);
    for (const instant of fired) {
      const local = localPartsAt(instant, TZ);
      expect(local.hour).toBe(12);
      expect(local.minute).toBe(0);
    }
    expect(new Set(fired).size).toBe(fired.length);
  });

  it("skips the local time that does not exist under skip_missing", () => {
    const spec = cron("30 2 * * *");
    const gapDayStart = Date.UTC(2027, 2, 14, 5, 0, 0);
    const plan = planSchedule(
      spec,
      { lastScheduledForMs: gapDayStart, activeRuns: 0 },
      gapDayStart + 86_400_000 - 1
    );

    expect(plan.fires).toHaveLength(0);
  });

  it("still fires the same authored local time the following day", () => {
    const spec = cron("30 2 * * *");
    const afterGapDay = Date.UTC(2027, 2, 15, 12, 0, 0);
    const plan = planSchedule(
      spec,
      { lastScheduledForMs: Date.UTC(2027, 2, 14, 5, 0, 0), activeRuns: 0 },
      afterGapDay
    );

    expect(plan.fires).toHaveLength(1);
    const local = localPartsAt(plan.fires[0]?.scheduledForMs as number, TZ);
    expect([local.hour, local.minute]).toEqual([2, 30]);
  });
});
