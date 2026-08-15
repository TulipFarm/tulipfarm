import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { ConfluenceKnowledgeSyncResult } from "@tulipfarm/integrations";
import { syncConfluenceKnowledge } from "@tulipfarm/integrations";
import { evaluateStaleness } from "@tulipfarm/knowledge";
import { recordJobRun } from "@tulipfarm/observability";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { PgBoss } from "pg-boss";
import type { ActivityService } from "../activity/service";
import type { ExternalLinkKnowledgeIdentityMap } from "../identity/knowledge-identity-map";
import { resolveConnectionEnv } from "../integrations/connection-env";
import type { PgConfluenceKnowledgeCheckpointStore } from "./confluence-checkpoint-store";
import { ConfluenceHttpKnowledgeApi } from "./confluence-http";
import type { PgKnowledgeEmissionSink } from "./emission-sink";
import type { PgKnowledgeSourceStore } from "./source-store";

export const CONFLUENCE_KNOWLEDGE_SYNC_QUEUE = "confluence-knowledge-sync";
/** Every 15 minutes, matching the generic connector and Slack Knowledge sync cadence. */
export const CONFLUENCE_KNOWLEDGE_SYNC_CRON = "*/15 * * * *";

export interface ConfluenceKnowledgeSyncScheduleDeps {
  readonly soulLoader: SoulLoader;
  readonly secrets: SecretsService;
  readonly checkpoints: PgConfluenceKnowledgeCheckpointStore;
  readonly sink: PgKnowledgeEmissionSink;
  readonly sources: PgKnowledgeSourceStore;
  readonly identity: ExternalLinkKnowledgeIdentityMap;
  readonly activity?: ActivityService;
  readonly now?: () => Date;
}

export interface ConfluenceIntegrationSyncResult extends ConfluenceKnowledgeSyncResult {
  readonly integrationId: string;
}

function isConfluence(slug: string, sourceIntegration: string): boolean {
  return slug === "confluence" || sourceIntegration === "confluence";
}

async function staleConfluencePageIds(
  deps: Pick<ConfluenceKnowledgeSyncScheduleDeps, "sources" | "now">
): Promise<readonly string[]> {
  const now = (deps.now ?? (() => new Date()))();
  const stale: string[] = [];
  for (const source of await deps.sources.list(DEPLOYMENT_BUSINESS_ID)) {
    if (source.provider !== "confluence" || source.status !== "active") continue;
    if (evaluateStaleness(source, now).stale) stale.push(source.externalId);
  }
  return stale;
}

/**
 * Sync every connected Confluence integration declared in Soul. Connection secrets stay sealed in
 * Soul and are resolved only here, at dispatch time.
 */
export async function runConfluenceKnowledgeSync(
  deps: ConfluenceKnowledgeSyncScheduleDeps
): Promise<readonly ConfluenceIntegrationSyncResult[]> {
  const results: ConfluenceIntegrationSyncResult[] = [];
  const revalidatePageIds = await staleConfluencePageIds(deps);

  for (const [slug, integration] of deps.soulLoader.integrations) {
    if (!isConfluence(slug, integration.sourceIntegration)) continue;
    if (integration.connection?.enabled !== true || integration.connection.env === undefined) {
      continue;
    }

    const env = await resolveConnectionEnv(integration.connection.env, deps.secrets).catch(
      () => undefined
    );
    const accessToken = env?.CONFLUENCE_ACCESS_TOKEN;
    const cloudId = env?.CONFLUENCE_CLOUD_ID;
    if (!accessToken || !cloudId) continue;

    const integrationId = `confluence:${slug}:${cloudId}`;
    const result = await syncConfluenceKnowledge(
      {
        api: new ConfluenceHttpKnowledgeApi({
          accessToken,
          cloudId,
          ...(env.CONFLUENCE_BASE_URL ? { baseUrl: env.CONFLUENCE_BASE_URL } : {}),
        }),
        checkpoints: deps.checkpoints,
        sink: deps.sink,
        identity: deps.identity,
        now: deps.now ?? (() => new Date()),
      },
      {
        businessId: DEPLOYMENT_BUSINESS_ID,
        integrationId,
        externalTenantId: cloudId,
        revalidatePageIds,
      }
    );
    results.push({ ...result, integrationId });
  }
  return results;
}

export async function registerConfluenceKnowledgeSync(
  boss: PgBoss,
  deps: ConfluenceKnowledgeSyncScheduleDeps
): Promise<void> {
  await boss.createQueue(CONFLUENCE_KNOWLEDGE_SYNC_QUEUE);
  await boss.work(CONFLUENCE_KNOWLEDGE_SYNC_QUEUE, () =>
    recordJobRun(
      deps.activity,
      CONFLUENCE_KNOWLEDGE_SYNC_QUEUE,
      () => runConfluenceKnowledgeSync(deps),
      (results) => ({
        summary: `Confluence Knowledge sync ran (${results.reduce(
          (count, result) => count + result.chunksIndexed,
          0
        )} chunk(s) indexed)`,
        metadata: { integrations: results.length },
      })
    )
  );
  await boss.schedule(CONFLUENCE_KNOWLEDGE_SYNC_QUEUE, CONFLUENCE_KNOWLEDGE_SYNC_CRON);
}
