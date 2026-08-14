import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeSourceEmission,
} from "@tulipfarm/integrations";
import type { KnowledgeSourceRecord } from "@tulipfarm/knowledge";
import type { PgKnowledgeIndexStore } from "./index-store";
import type { PgKnowledgeSourceStore } from "./source-store";

/** Field-for-field projection; `KnowledgeSourceEmission` and record shapes must drift together. */
function toSourceRecord(source: KnowledgeSourceEmission): KnowledgeSourceRecord {
  return {
    sourceId: source.sourceId,
    businessId: source.businessId,
    integrationId: source.integrationId,
    provider: source.provider,
    externalId: source.externalId,
    externalTenantId: source.externalTenantId,
    ownerExternalId: source.ownerExternalId,
    revision: source.revision,
    classification: source.classification,
    status: source.status,
    verification: source.verification,
    accessControl: source.accessControl,
    ...(source.acl === undefined ? {} : { acl: source.acl }),
    provenance: source.provenance,
    lastSyncedAt: source.lastSyncedAt,
  };
}

/** Composes source/index stores; revoked content is removed in the same sync pass. */
export class PgKnowledgeEmissionSink implements KnowledgeEmissionSink {
  constructor(
    private readonly sources: PgKnowledgeSourceStore,
    private readonly index: PgKnowledgeIndexStore
  ) {}

  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    await this.sources.put(toSourceRecord(source));
  }

  async emitChunk(chunk: KnowledgeChunkEmission): Promise<void> {
    await this.index.upsert(chunk);
  }

  async removeSourceContent(businessId: string, sourceId: string): Promise<void> {
    await this.index.removeSource(businessId, sourceId);
  }

  async removeChunk(businessId: string, sourceId: string, chunkId: string): Promise<void> {
    await this.index.removeChunk(businessId, sourceId, chunkId);
  }
}
