/**
 * Runtime Knowledge source record; `acl.ts` is the only place it becomes an access decision.
 */

/** Lifecycle of the external record behind a source. Anything but `active` is unreachable. */
export type KnowledgeSourceStatus = "active" | "revoked" | "deleted";

/** `unverifiable` access control denies rather than falling back to cached or empty ACLs. */
export type KnowledgeSourceVerification = "verified" | "unverifiable";

export interface KnowledgePrincipalRef {
  readonly kind: string;
  readonly id: string;
}

/** Live provider authorization revalidates every sensitive read within `maximumAgeSeconds`. */
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
