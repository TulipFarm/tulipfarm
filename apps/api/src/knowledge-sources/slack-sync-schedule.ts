import type { PgBoss } from "pg-boss";

export const SLACK_KNOWLEDGE_SYNC_QUEUE = "slack-knowledge-sync";

/** Remove the persisted legacy schedule so upgrades stop enqueueing unconsumed jobs. */
export async function retireSlackKnowledgeSyncSchedule(
  boss: Pick<PgBoss, "unschedule">
): Promise<void> {
  await boss.unschedule(SLACK_KNOWLEDGE_SYNC_QUEUE);
}
