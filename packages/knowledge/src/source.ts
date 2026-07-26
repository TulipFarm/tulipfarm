/**
 * Canonical runtime shape of a Knowledge source (SPEC §14.1).
 *
 * Every Integration that contributes Knowledge captures source identity, the ACL or access-check
 * mechanism, revision, owner/tenant, classification, and provenance. This module owns that record;
 * `acl.ts` is the only place it becomes an access decision. The authored counterpart lives in
 * `@tulipfarm/schema` as the `KnowledgeSource` definition — {@link knowledgeSourceFromDefinition}
 * keeps the two in lockstep so an authored source can never describe an access-control mode the
 * runtime does not understand.
 */

import type { KnowledgeSourceDefinition } from "@tulipfarm/schema";

/** Lifecycle of the external record behind a source. Anything but `active` is unreachable. */
export type KnowledgeSourceStatus = "active" | "revoked" | "deleted";

/**
 * Whether the source's access control is trustworthy right now. `unverifiable` is what an
 * Integration reports when it could not read the provider's permissions — it denies (SPEC §14.1
 * "if the source cannot provide verifiable access, retrieval is denied"), it does not fall back.
 */
export type KnowledgeSourceVerification = "verified" | "unverifiable";

export interface KnowledgePrincipalRef {
  readonly kind: string;
  readonly id: string;
}

/** Live provider authorization: every sensitive read revalidates, bounded by `maximumAgeSeconds`. */
export interface LiveAccessControl {
  readonly mode: "live";
  readonly maximumAgeSeconds: number;
}

/** Snapshot authorization: an explicitly captured ACL with a short, explicit TTL. */
export interface SnapshotAccessControl {
  readonly mode: "snapshot";
  readonly aclRevision: string;
  readonly maximumAgeSeconds: number;
}

export type KnowledgeAccessControl = LiveAccessControl | SnapshotAccessControl;

/**
 * A captured ACL. `principals` is a closed allow list: absence is denial, and there is no
 * wildcard. `capturedAt` is what the TTL is measured against.
 */
export interface KnowledgeAclSnapshot {
  readonly aclRevision: string;
  readonly capturedAt: string;
  readonly principals: readonly KnowledgePrincipalRef[];
}

/** Where the indexed content came from, so a response can cite source and revision. */
export interface KnowledgeProvenance {
  readonly capturedAt: string;
  readonly contentHash: string;
  /** Sync checkpoint that produced this capture; lets invalidation replay from a known point. */
  readonly checkpoint?: string;
}

export interface KnowledgeSourceRecord {
  readonly sourceId: string;
  readonly businessId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly externalTenantId: string;
  readonly ownerExternalId: string;
  /** Provider revision of the content. A new revision invalidates derived artifacts. */
  readonly revision: string;
  readonly classification: readonly string[];
  readonly status: KnowledgeSourceStatus;
  readonly verification: KnowledgeSourceVerification;
  readonly accessControl: KnowledgeAccessControl;
  /** Required in `snapshot` mode; ignored in `live` mode. */
  readonly acl?: KnowledgeAclSnapshot;
  readonly provenance: KnowledgeProvenance;
  /** Last time the Integration confirmed this record still reflects the provider. */
  readonly lastSyncedAt: string;
}

/** Read side of source storage. Retrieval authorizes against these records before any ranking. */
export interface KnowledgeSourceStore {
  /** Every source the business has, authorized or not. Authorization happens in `acl.ts`. */
  list(businessId: string): Promise<readonly KnowledgeSourceRecord[]>;
  get(businessId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined>;
}

export interface MutableKnowledgeSourceStore extends KnowledgeSourceStore {
  put(record: KnowledgeSourceRecord): Promise<void>;
}

/** Deterministic in-memory store for tests and single-process composition. */
export class InMemoryKnowledgeSourceStore implements MutableKnowledgeSourceStore {
  private readonly byKey = new Map<string, KnowledgeSourceRecord>();

  constructor(records: readonly KnowledgeSourceRecord[] = []) {
    for (const record of records) this.byKey.set(`${record.businessId}/${record.sourceId}`, record);
  }

  async list(businessId: string): Promise<readonly KnowledgeSourceRecord[]> {
    return [...this.byKey.values()].filter((record) => record.businessId === businessId);
  }

  async get(businessId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined> {
    return this.byKey.get(`${businessId}/${sourceId}`);
  }

  async put(record: KnowledgeSourceRecord): Promise<void> {
    this.byKey.set(`${record.businessId}/${record.sourceId}`, record);
  }
}

export interface KnowledgeSourceRuntimeInput {
  readonly businessId: string;
  readonly revision: string;
  readonly status: KnowledgeSourceStatus;
  readonly verification: KnowledgeSourceVerification;
  readonly provenance: KnowledgeProvenance;
  readonly lastSyncedAt: string;
  readonly acl?: KnowledgeAclSnapshot;
}

/**
 * Project an authored `KnowledgeSource` definition plus the current sync observation into the
 * runtime record. A snapshot-mode source with no captured ACL is returned as `unverifiable`
 * rather than as an empty allow list, so a mis-synced source denies loudly instead of quietly
 * matching nothing.
 */
export function knowledgeSourceFromDefinition(
  definition: KnowledgeSourceDefinition,
  runtime: KnowledgeSourceRuntimeInput
): KnowledgeSourceRecord {
  const { accessControl } = definition.spec;
  const aclMissing = accessControl.mode === "snapshot" && runtime.acl === undefined;
  return {
    sourceId: definition.metadata.id,
    businessId: runtime.businessId,
    integrationId: definition.spec.integrationId,
    provider: definition.spec.source.provider,
    externalId: definition.spec.source.externalId,
    externalTenantId: definition.spec.source.externalTenantId,
    ownerExternalId: definition.spec.source.ownerExternalId,
    revision: runtime.revision,
    classification: definition.spec.classification,
    status: runtime.status,
    verification: aclMissing ? "unverifiable" : runtime.verification,
    accessControl,
    ...(runtime.acl === undefined ? {} : { acl: runtime.acl }),
    provenance: runtime.provenance,
    lastSyncedAt: runtime.lastSyncedAt,
  };
}
