import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  DriveKnowledgeSyncResult,
  GoogleDocsKnowledgeSyncResult,
  NotionKnowledgeSyncResult,
} from "@tulipfarm/integrations";
import {
  syncDriveKnowledge,
  syncGoogleDocsKnowledge,
  syncNotionKnowledge,
} from "@tulipfarm/integrations";
import { evaluateStaleness } from "@tulipfarm/knowledge";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { PgBoss } from "pg-boss";
import { recordJobRun } from "../activity/job-run";
import type { ActivityService } from "../activity/service";
import type { ExternalLinkKnowledgeIdentityMap } from "../identity/knowledge-identity-map";
import { resolveConnectionEnv } from "../integrations/connection-env";
import type { PgKnowledgeEmissionSink } from "./emission-sink";
import { GoogleDocsHttpKnowledgeApi, GoogleDriveHttpKnowledgeApi } from "./google-http";
import { NotionHttpKnowledgeApi } from "./notion-http";
import type { PgKnowledgeSourceStore } from "./source-store";
import type { PgProviderKnowledgeCheckpointStore } from "./sync-checkpoint-store";

export const K3_KNOWLEDGE_SYNC_QUEUE = "k3-knowledge-sync";
export const K3_KNOWLEDGE_SYNC_CRON = "*/15 * * * *";

type K3Provider = "google-drive" | "google-docs" | "notion";

export interface K3KnowledgeSyncScheduleDeps {
  readonly soulLoader: SoulLoader;
  readonly secrets: SecretsService;
  readonly checkpoints: (provider: K3Provider) => PgProviderKnowledgeCheckpointStore;
  readonly sink: PgKnowledgeEmissionSink;
  readonly sources: PgKnowledgeSourceStore;
  readonly identity: ExternalLinkKnowledgeIdentityMap;
  readonly activity?: ActivityService;
  readonly now?: () => Date;
}

export interface K3IntegrationSyncResult {
  readonly provider: K3Provider;
  readonly integrationId: string;
  readonly result:
    | DriveKnowledgeSyncResult
    | GoogleDocsKnowledgeSyncResult
    | NotionKnowledgeSyncResult;
}

function isProvider(slug: string, sourceIntegration: string, provider: K3Provider): boolean {
  return slug === provider || sourceIntegration === provider;
}

async function staleExternalIds(
  deps: Pick<K3KnowledgeSyncScheduleDeps, "sources" | "now">,
  provider: K3Provider
): Promise<readonly string[]> {
  const now = (deps.now ?? (() => new Date()))();
  const stale: string[] = [];
  for (const source of await deps.sources.list(DEPLOYMENT_BUSINESS_ID)) {
    if (source.provider !== provider || source.status !== "active") continue;
    if (evaluateStaleness(source, now).stale) stale.push(source.externalId);
  }
  return stale;
}

const EXTRACTION_RULES = [
  {
    id: "extract-public",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "public",
  },
  {
    id: "extract-internal",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "internal",
  },
  {
    id: "extract-confidential",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "confidential",
  },
  {
    id: "extract-restricted",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "restricted",
  },
] as const;

export async function runK3KnowledgeSync(
  deps: K3KnowledgeSyncScheduleDeps
): Promise<readonly K3IntegrationSyncResult[]> {
  const results: K3IntegrationSyncResult[] = [];
  const staleDriveIds = await staleExternalIds(deps, "google-drive");
  const staleDocsIds = await staleExternalIds(deps, "google-docs");
  const staleNotionIds = await staleExternalIds(deps, "notion");

  for (const [slug, integration] of deps.soulLoader.integrations) {
    if (integration.connection?.enabled !== true || integration.connection.env === undefined) {
      continue;
    }
    const env = await resolveConnectionEnv(integration.connection.env, deps.secrets).catch(
      () => undefined
    );
    if (env === undefined) continue;

    if (isProvider(slug, integration.sourceIntegration, "google-drive")) {
      const token = env.GOOGLE_DRIVE_ACCESS_TOKEN;
      const tenantId = env.GOOGLE_DRIVE_TENANT_ID ?? env.GOOGLE_WORKSPACE_ID;
      if (!token || !tenantId) continue;
      const integrationId = `google-drive:${slug}:${tenantId}`;
      results.push({
        provider: "google-drive",
        integrationId,
        result: await syncDriveKnowledge(
          {
            api: new GoogleDriveHttpKnowledgeApi({
              accessToken: token,
              tenantId,
              ...(env.GOOGLE_DRIVE_BASE_URL ? { baseUrl: env.GOOGLE_DRIVE_BASE_URL } : {}),
            }),
            checkpoints: deps.checkpoints("google-drive"),
            sink: deps.sink,
            identity: deps.identity,
            now: deps.now ?? (() => new Date()),
          },
          {
            businessId: DEPLOYMENT_BUSINESS_ID,
            integrationId,
            externalTenantId: tenantId,
            extraction: { rules: EXTRACTION_RULES },
            revalidateFileIds: staleDriveIds,
          }
        ),
      });
    }

    if (isProvider(slug, integration.sourceIntegration, "google-docs")) {
      const token = env.GOOGLE_DOCS_ACCESS_TOKEN ?? env.GOOGLE_DRIVE_ACCESS_TOKEN;
      const tenantId = env.GOOGLE_DOCS_TENANT_ID ?? env.GOOGLE_WORKSPACE_ID;
      if (!token || !tenantId) continue;
      const integrationId = `google-docs:${slug}:${tenantId}`;
      results.push({
        provider: "google-docs",
        integrationId,
        result: await syncGoogleDocsKnowledge(
          {
            api: new GoogleDocsHttpKnowledgeApi({
              accessToken: token,
              tenantId,
              ...(env.GOOGLE_DRIVE_BASE_URL ? { baseUrl: env.GOOGLE_DRIVE_BASE_URL } : {}),
            }),
            checkpoints: deps.checkpoints("google-docs"),
            sink: deps.sink,
            identity: deps.identity,
            now: deps.now ?? (() => new Date()),
          },
          {
            businessId: DEPLOYMENT_BUSINESS_ID,
            integrationId,
            externalTenantId: tenantId,
            revalidateDocumentIds: staleDocsIds,
          }
        ),
      });
    }

    if (isProvider(slug, integration.sourceIntegration, "notion")) {
      const token = env.NOTION_ACCESS_TOKEN;
      const workspaceId = env.NOTION_WORKSPACE_ID;
      if (!token || !workspaceId) continue;
      const integrationId = `notion:${slug}:${workspaceId}`;
      results.push({
        provider: "notion",
        integrationId,
        result: await syncNotionKnowledge(
          {
            api: new NotionHttpKnowledgeApi({
              accessToken: token,
              workspaceId,
              ...(env.NOTION_READER_PROPERTY
                ? { readerPropertyName: env.NOTION_READER_PROPERTY }
                : {}),
              ...(env.NOTION_BASE_URL ? { baseUrl: env.NOTION_BASE_URL } : {}),
            }),
            checkpoints: deps.checkpoints("notion"),
            sink: deps.sink,
            identity: deps.identity,
            now: deps.now ?? (() => new Date()),
          },
          {
            businessId: DEPLOYMENT_BUSINESS_ID,
            integrationId,
            externalTenantId: workspaceId,
            revalidatePageIds: staleNotionIds,
          }
        ),
      });
    }
  }

  return results;
}

export async function registerK3KnowledgeSync(
  boss: PgBoss,
  deps: K3KnowledgeSyncScheduleDeps
): Promise<void> {
  await boss.createQueue(K3_KNOWLEDGE_SYNC_QUEUE);
  await boss.work(K3_KNOWLEDGE_SYNC_QUEUE, () =>
    recordJobRun(
      deps.activity,
      K3_KNOWLEDGE_SYNC_QUEUE,
      () => runK3KnowledgeSync(deps),
      (results) => ({
        summary: `K3 Knowledge sync ran (${results.reduce(
          (count, item) => count + ("chunksIndexed" in item.result ? item.result.chunksIndexed : 0),
          0
        )} chunk(s) indexed)`,
        metadata: { integrations: results.length },
      })
    )
  );
  await boss.schedule(K3_KNOWLEDGE_SYNC_QUEUE, K3_KNOWLEDGE_SYNC_CRON);
}
