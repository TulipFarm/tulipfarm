import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type KnowledgeIdentityMapPort,
  type SlackKnowledgeCheckpointStore,
  type SlackKnowledgeSyncResult,
  syncSlackKnowledge,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { PgBoss } from "pg-boss";
import { recordJobRun } from "../activity/job-run";
import type { ActivityService } from "../activity/service";
import { integrationSecretKey } from "../integrations/connection-env";
import type { PgKnowledgeEmissionSink } from "./emission-sink";
import { SlackHttpKnowledgeApi } from "./slack-http";

export const SLACK_KNOWLEDGE_SYNC_QUEUE = "slack-knowledge-sync";
/** Every 15 minutes, matching `CONNECTOR_SYNC_CRON`. */
export const SLACK_KNOWLEDGE_SYNC_CRON = "*/15 * * * *";

export interface SlackKnowledgeSyncScheduleDeps {
  readonly integrations: IntegrationStore;
  readonly secrets: SecretsService;
  readonly checkpoints: SlackKnowledgeCheckpointStore;
  readonly sink: PgKnowledgeEmissionSink;
  readonly identity: KnowledgeIdentityMapPort;
  readonly activity?: ActivityService;
  readonly now?: () => Date;
}

export interface SlackIntegrationSyncResult extends SlackKnowledgeSyncResult {
  readonly integrationId: string;
}

/**
 * Sync every active Slack Integration this (single-tenant) deployment has connected — mirrors
 * `../knowledge/connectors/sync.ts`'s `registerConnectorSync`, but keyed off `IntegrationStore`
 * rather than the generic `Connector` registry, since Slack's per-channel checkpoint model doesn't
 * fit that shape. One Integration's failure is isolated by `syncSlackKnowledge` itself (it never
 * throws — failures come back as result entries), so it cannot stall another workspace's sync.
 */
export async function runSlackKnowledgeSync(
  deps: SlackKnowledgeSyncScheduleDeps
): Promise<readonly SlackIntegrationSyncResult[]> {
  const snapshot = await deps.integrations.loadProviderSnapshot(DEPLOYMENT_BUSINESS_ID, "slack");
  const results: SlackIntegrationSyncResult[] = [];

  for (const integration of snapshot.integrations) {
    if (integration.status !== "active") continue;
    const token = await deps.secrets
      .get(integrationSecretKey("slack", "SLACK_BOT_TOKEN"))
      .catch(() => undefined);
    if (!token) continue; // Not (yet) connected — nothing to sync for this Integration.

    const result = await syncSlackKnowledge(
      {
        api: new SlackHttpKnowledgeApi({ token, teamId: integration.externalTenantId }),
        checkpoints: deps.checkpoints,
        sink: deps.sink,
        identity: deps.identity,
        now: deps.now ?? (() => new Date()),
      },
      {
        businessId: DEPLOYMENT_BUSINESS_ID,
        integrationId: integration.id,
        externalTenantId: integration.externalTenantId,
      }
    );
    results.push({ ...result, integrationId: integration.id });
  }
  return results;
}

/** Register the scheduled Slack Knowledge sync job (mirrors `registerConnectorSync`). */
export async function registerSlackKnowledgeSync(
  boss: PgBoss,
  deps: SlackKnowledgeSyncScheduleDeps
): Promise<void> {
  await boss.createQueue(SLACK_KNOWLEDGE_SYNC_QUEUE);
  await boss.work(SLACK_KNOWLEDGE_SYNC_QUEUE, () =>
    recordJobRun(
      deps.activity,
      SLACK_KNOWLEDGE_SYNC_QUEUE,
      () => runSlackKnowledgeSync(deps),
      (results) => ({
        summary: `Slack Knowledge sync ran (${results.reduce((n, r) => n + r.messagesIndexed, 0)} message(s) indexed)`,
        metadata: { integrations: results.length },
      })
    )
  );
  await boss.schedule(SLACK_KNOWLEDGE_SYNC_QUEUE, SLACK_KNOWLEDGE_SYNC_CRON);
}
