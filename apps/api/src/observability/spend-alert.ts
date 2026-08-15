import type { PgBoss } from "pg-boss";

export const SPEND_ALERT_QUEUE = "obs-spend-alert";
/** Hourly. A daily budget checked once a day can be breached for 23 hours before it is said. */
export const SPEND_ALERT_CRON = "23 * * * *";

/**
 * Publishes the configured daily spend ceiling for the Worker to check against real spend.
 *
 * `spend_alert_usd` was a number on a settings page that did nothing: the only thing that read it
 * was a comment in the shipped Grafana rule saying the operator should keep a hard-coded `> 50`
 * in a separate YAML in sync with it by hand. An operator who set it reasonably believed they had
 * configured an alert, and a runaway agent would have said nothing at all.
 *
 * An unset threshold registers no schedule: there is no default budget an operator did not ask
 * for, and inventing one would page somebody over a number nobody chose.
 */
export async function registerSpendAlertSchedule(
  boss: PgBoss,
  thresholdUsd: number | null
): Promise<void> {
  await boss.createQueue(SPEND_ALERT_QUEUE);
  if (thresholdUsd === null || !Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
    // Clear any schedule left behind by a previous configuration, or the old ceiling keeps firing.
    await boss.unschedule(SPEND_ALERT_QUEUE);
    return;
  }
  await boss.schedule(SPEND_ALERT_QUEUE, SPEND_ALERT_CRON, { thresholdUsd });
}
