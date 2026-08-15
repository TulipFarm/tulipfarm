import { describe, expect, it } from "vitest";
import { registerSpendAlertSchedule, SPEND_ALERT_QUEUE } from "./spend-alert";

function boss() {
  const scheduled: { queue: string; cron: string; data: unknown }[] = [];
  const unscheduled: string[] = [];
  return {
    scheduled,
    unscheduled,
    api: {
      createQueue: async () => undefined,
      schedule: async (queue: string, cron: string, data: unknown) => {
        scheduled.push({ queue, cron, data });
      },
      unschedule: async (queue: string) => {
        unscheduled.push(queue);
      },
    },
  };
}

describe("registerSpendAlertSchedule", () => {
  it("schedules a check against the configured ceiling", async () => {
    const b = boss();

    // Nothing read this number before: the only reference was a comment telling the operator to
    // keep a hard-coded threshold in a separate Grafana YAML in sync with it by hand.
    await registerSpendAlertSchedule(b.api as never, 50);

    expect(b.scheduled).toEqual([
      { queue: SPEND_ALERT_QUEUE, cron: expect.any(String), data: { thresholdUsd: 50 } },
    ]);
  });

  it("schedules nothing when no ceiling is set", async () => {
    const b = boss();

    await registerSpendAlertSchedule(b.api as never, null);

    // Inventing a default would page an operator over a number nobody chose.
    expect(b.scheduled).toEqual([]);
  });

  it("clears a ceiling that was removed, rather than leaving the old one firing", async () => {
    const b = boss();

    await registerSpendAlertSchedule(b.api as never, null);

    expect(b.unscheduled).toEqual([SPEND_ALERT_QUEUE]);
  });

  it("treats a nonsensical ceiling as unset", async () => {
    const b = boss();

    await registerSpendAlertSchedule(b.api as never, 0);
    await registerSpendAlertSchedule(b.api as never, Number.NaN);

    expect(b.scheduled).toEqual([]);
  });
});
