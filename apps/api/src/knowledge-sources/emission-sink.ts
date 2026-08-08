import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeSourceEmission,
} from "@tulipfarm/integrations";
import type { KnowledgeSourceRecord } from "@tulipfarm/knowledge";
import type { PgKnowledgeIndexStore } from "./index-store";
import type { PgKnowledgeSourceStore } from "./source-store";

/**
 * `KnowledgeSourceEmission` is structurally identical to `KnowledgeSourceRecord` by design
 * (`packages/integrations/src/knowledge/source.ts`'s doc comment) — this is a field-for-field
 * projection, not a transform, so the two shapes cannot silently drift without a compile error.
 */
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

/**
 * Composes the Postgres source/index stores into the emission sink adapters own
 * (`@tulipfarm/integrations` may not import `@tulipfarm/knowledge`, per
 * `packages/integrations/AGENTS.md`). `emitSource`+`removeSourceContent` are called in the same
 * pass by every caller in `sync.ts` (revoked/archived/unverifiable sources), so a crash between the
 * two never leaves readable content behind an unreachable record for longer than the next resync.
 */
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
