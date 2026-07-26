/**
 * What a Knowledge Integration emits (SPEC §14.1, §15).
 *
 * `@tulipfarm/integrations` may not import `@tulipfarm/knowledge` (see
 * `docs/architecture/dependency-rules.md`), so this is the provider-neutral emission contract the
 * source adapters produce and the composing application feeds into the Knowledge store. It is
 * structurally identical to `KnowledgeSourceRecord`/`KnowledgeIndexEntry`; `apps/worker` owns the
 * conformance test that keeps the two shapes from drifting.
 *
 * Every field an adapter cannot establish honestly has a fail-closed representation: a source whose
 * permissions could not be read is emitted as `unverifiable` (which denies) rather than omitted or
 * defaulted to an empty-but-verified ACL.
 */

export type EmittedSourceStatus = "active" | "revoked" | "deleted";
export type EmittedSourceVerification = "verified" | "unverifiable";

export interface EmittedPrincipalRef {
  readonly kind: string;
  readonly id: string;
}

export interface EmittedLiveAccessControl {
  readonly mode: "live";
  readonly maximumAgeSeconds: number;
}

export interface EmittedSnapshotAccessControl {
  readonly mode: "snapshot";
  readonly aclRevision: string;
  readonly maximumAgeSeconds: number;
}

export type EmittedAccessControl = EmittedLiveAccessControl | EmittedSnapshotAccessControl;

export interface EmittedAclSnapshot {
  readonly aclRevision: string;
  readonly capturedAt: string;
  readonly principals: readonly EmittedPrincipalRef[];
}

export interface EmittedProvenance {
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly checkpoint?: string;
}

export interface KnowledgeSourceEmission {
  readonly sourceId: string;
  readonly businessId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly externalTenantId: string;
  readonly ownerExternalId: string;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly status: EmittedSourceStatus;
  readonly verification: EmittedSourceVerification;
  readonly accessControl: EmittedAccessControl;
  readonly acl?: EmittedAclSnapshot;
  readonly provenance: EmittedProvenance;
  readonly lastSyncedAt: string;
}

export interface KnowledgeChunkEmission {
  readonly businessId: string;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly text: string;
}

/**
 * Where an adapter hands its work off. The two removal methods are not optimisations: a deleted or
 * revoked source must lose its indexed text in the same pass that marks it deleted, so a crash
 * between the two cannot leave readable content behind an unreachable record. `removeChunk` is the
 * same guarantee at message granularity, for sources where individual items are deleted while the
 * source itself stays live.
 */
export interface KnowledgeEmissionSink {
  emitSource(source: KnowledgeSourceEmission): Promise<void>;
  emitChunk(chunk: KnowledgeChunkEmission): Promise<void>;
  removeSourceContent(businessId: string, sourceId: string): Promise<void>;
  removeChunk(businessId: string, sourceId: string, chunkId: string): Promise<void>;
}

/**
 * Resolve an external subject (a Drive permission holder, a Slack member) to the Tulip principals
 * it maps to. `undefined` drops that subject from the ACL — an unmapped external identity never
 * becomes an implicit grant, and never borrows another principal's identity.
 */
export interface KnowledgeIdentityMapPort {
  resolve(input: {
    readonly businessId: string;
    readonly provider: string;
    readonly externalSubject: string;
  }): Promise<readonly EmittedPrincipalRef[] | undefined>;
}

const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** Strongest classification present. An unknown label ranks above every known one (fail-closed). */
export function strongestClassification(values: readonly string[]): string {
  return values.reduce(
    (strongest, value) =>
      (CLASSIFICATION_RANK[value] ?? Number.MAX_SAFE_INTEGER) >
      (CLASSIFICATION_RANK[strongest] ?? Number.MAX_SAFE_INTEGER)
        ? value
        : strongest,
    values[0] ?? "restricted"
  );
}

/** Deterministic, collision-free source id: provider plus the provider-local identifier. */
export function knowledgeSourceId(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}
