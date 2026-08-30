import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type KnowledgeIdentityMapPort,
  SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS,
  type SlackKnowledgeCheckpointStore,
  type SlackKnowledgeSyncResult,
  syncSlackKnowledge,
} from "@tulipfarm/integrations";
import { recordJobRun } from "@tulipfarm/observability";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { PgBoss } from "pg-boss";
import type { ActivityService } from "../activity/service";
import { integrationSecretKey } from "../integrations/connection-env";
import type { PgKnowledgeEmissionSink } from "./emission-sink";
import { SlackHttpKnowledgeApi } from "./slack-http";

export const SLACK_KNOWLEDGE_SYNC_QUEUE = "slack-knowledge-sync";
/**
 * Derived from `SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS`, the same constant `syncSlackKnowledge`
 * uses to size the captured ACL snapshot's max age, so the two can never drift out of the
 * refresh-within-validity-window relationship that keeps `acl_stale` denials from firing on a
 * fresh snapshot. Every 5 minutes: this cadence is *also* the revocation window — how long
 * someone dropped from a Slack channel keeps read access to its indexed content — so the max
 * age is sized off this constant rather than the other way around, to avoid trading a
 * staleness fix for a wider security window.
 */
export const SLACK_KNOWLEDGE_SYNC_CRON = `*/${SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS / 60} * * * *`;

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

/** Sync active Slack Integrations; per-Integration failures return as results and do not stall. */
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
      (results) => {
        const indexed = results.reduce((n, r) => n + r.messagesIndexed, 0);
        return {
          summary: `Slack Knowledge sync indexed ${indexed} ${indexed === 1 ? "message" : "messages"}`,
          metadata: { integrations: results.length },
        };
      }
    )
  );
  await boss.schedule(SLACK_KNOWLEDGE_SYNC_QUEUE, SLACK_KNOWLEDGE_SYNC_CRON);
}
