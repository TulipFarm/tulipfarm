/**
 * The one shape the Knowledge gate decides on.
 *
 * An authored Page is a Source whose provider is TulipFarm itself: it has content, a revision, a
 * lifecycle and readers — the same four things a synced document has. Projecting both onto
 * `KnowledgeSubject` is what lets one gate serve authored and connected content without inventing a
 * second authorization vocabulary.
 */

import type {
  KnowledgeAccessControl,
  KnowledgeAclSnapshot,
  KnowledgePrincipalRef,
  KnowledgeSourceRecord,
  KnowledgeSourceStatus,
  KnowledgeSourceVerification,
} from "./source";

/** What an ACL entry hangs off. Space entries are inherited by every Page beneath them. */
export type KnowledgeSubjectKind = "space" | "page" | "source";

export type KnowledgeAclEffect = "grant" | "deny";

/**
 * Only `read` is evaluated today. The dimension exists so that a later write/comment split is a
 * policy change rather than a migration.
 */
export type KnowledgeAclCapability = "read";

export interface KnowledgeAclEntry {
  readonly subjectKind: KnowledgeSubjectKind;
  readonly subjectId: string;
  readonly principal: KnowledgePrincipalRef;
  readonly effect: KnowledgeAclEffect;
  readonly capability: KnowledgeAclCapability;
}

export interface KnowledgeSubject {
  readonly subjectKind: KnowledgeSubjectKind;
  readonly subjectId: string;
  readonly businessId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly revision: string;
  readonly status: KnowledgeSourceStatus;
  readonly verification: KnowledgeSourceVerification;
  readonly accessControl: KnowledgeAccessControl;
  /** Required in `snapshot` mode; ignored in `live` mode. */
  readonly acl?: KnowledgeAclSnapshot;
  /** Grants and denies applicable here, with any inherited parent entries already merged in. */
  readonly entries: readonly KnowledgeAclEntry[];
}

/** The provider name an authored Page carries, so `provider` is total across both halves. */
export const AUTHORED_PROVIDER = "tulipfarm";

/**
 * "Everyone in this Business". Held only by signed-in human members, and resolved per request
 * rather than stored, so it can never drift out of step with actual membership.
 */
export const BLANKET_READ_PRINCIPAL: KnowledgePrincipalRef = { kind: "role", id: "role-everyone" };

/**
 * How long an authored Page's projected ACL capture stays usable. Entries are read from our own
 * database during the request, so the capture is genuinely fresh; this bound exists only so a
 * malformed timestamp denies rather than reads as infinitely young.
 */
export const AUTHORED_ACL_MAX_AGE_SECONDS = 300;

export interface AuthoredPage {
  readonly pageId: string;
  readonly spaceId: string | null;
  readonly businessId: string;
  readonly revision: string;
  readonly aclRevision: string;
  readonly status: KnowledgeSourceStatus;
}

/**
 * Projects an authored Page onto the gate's subject shape.
 *
 * `capturedAt` is `now` because the entries were just read from our own store — we are the provider
 * for authored content, so its ACL cannot have drifted from the provider's.
 */
export function pageSubject(
  page: AuthoredPage,
  entries: readonly KnowledgeAclEntry[],
  now: Date
): KnowledgeSubject {
  return {
    subjectKind: "page",
    subjectId: page.pageId,
    businessId: page.businessId,
    provider: AUTHORED_PROVIDER,
    externalId: page.pageId,
    revision: page.revision,
    status: page.status,
    verification: "verified",
    accessControl: {
      mode: "snapshot",
      aclRevision: page.aclRevision,
      maximumAgeSeconds: AUTHORED_ACL_MAX_AGE_SECONDS,
    },
    acl: { aclRevision: page.aclRevision, capturedAt: now.toISOString(), principals: [] },
    entries,
  };
}

/** A captured snapshot principal is a grant; `extra` carries stored grants and denies. */
export function sourceSubject(
  source: KnowledgeSourceRecord,
  extra: readonly KnowledgeAclEntry[] = []
): KnowledgeSubject {
  const captured: readonly KnowledgeAclEntry[] = (source.acl?.principals ?? []).map(
    (principal) => ({
      subjectKind: "source" as const,
      subjectId: source.sourceId,
      principal,
      effect: "grant" as const,
      capability: "read" as const,
    })
  );
  return {
    subjectKind: "source",
    subjectId: source.sourceId,
    businessId: source.businessId,
    provider: source.provider,
    externalId: source.externalId,
    revision: source.revision,
    status: source.status,
    verification: source.verification,
    accessControl: source.accessControl,
    ...(source.acl === undefined ? {} : { acl: source.acl }),
    entries: [...captured, ...extra],
  };
}

/**
 * Read side of authored-subject storage. Retrieval authorizes every subject this returns before any
 * ranking, exactly as it does for source records.
 */
export interface KnowledgeSubjectStore {
  listAuthored(businessId: string): Promise<readonly KnowledgeSubject[]>;
  getAuthored(businessId: string, subjectId: string): Promise<KnowledgeSubject | undefined>;
}

/**
 * Expands the acting principal into everything they hold — themselves, their roles, their provider
 * groups — once per query.
 *
 * Grants are stored naming the group and are never flattened into members, so removing someone from
 * a group takes effect on their next question rather than on the next reindex.
 */
export interface PrincipalResolverPort {
  resolve(input: {
    readonly businessId: string;
    readonly principals: readonly KnowledgePrincipalRef[];
  }): Promise<readonly KnowledgePrincipalRef[]>;
}

/** Deterministic in-memory store for tests and single-process composition. */
export class InMemoryKnowledgeSubjectStore implements KnowledgeSubjectStore {
  private readonly byKey = new Map<string, KnowledgeSubject>();

  constructor(subjects: readonly KnowledgeSubject[] = []) {
    for (const subject of subjects)
      this.byKey.set(this.key(subject.businessId, subject.subjectId), subject);
  }

  private key(businessId: string, subjectId: string): string {
    return `${businessId}/${subjectId}`;
  }

  async listAuthored(businessId: string): Promise<readonly KnowledgeSubject[]> {
    return [...this.byKey.values()].filter((subject) => subject.businessId === businessId);
  }

  async getAuthored(businessId: string, subjectId: string): Promise<KnowledgeSubject | undefined> {
    return this.byKey.get(this.key(businessId, subjectId));
  }

  async put(subject: KnowledgeSubject): Promise<void> {
    this.byKey.set(this.key(subject.businessId, subject.subjectId), subject);
  }

  async delete(businessId: string, subjectId: string): Promise<void> {
    this.byKey.delete(this.key(businessId, subjectId));
  }
}
