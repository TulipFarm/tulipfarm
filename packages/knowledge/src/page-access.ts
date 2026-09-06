/**
 * The read gate for authored Pages. Every Page-returning surface consults this — REST routes and
 * Agent Tools alike — so authorization lives in one place rather than being re-derived per caller.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "@tulipfarm/storage";
import { decideKnowledgeAccess } from "./acl";
import { PgKnowledgeSubjectStore, PgPrincipalResolver } from "./acl-repo";
import { canonicalKnowledgeId, isKnowledgeId } from "./ids";
import type { KnowledgeOwnershipPort } from "./subject";

/** What a caller may render, plus how much was withheld — never which Pages. */
export interface ReadablePages {
  readonly allowed: readonly string[];
  readonly excluded: number;
}

/**
 * The read authorization every Page-returning surface depends on. Required rather than optional on
 * purpose: an absent gate must be a compile error, never a silently ungated route.
 */
export interface PageReadAuthorizer {
  canRead(userId: string | undefined, pageId: string): Promise<boolean>;
  readablePageIds(userId: string | undefined, pageIds: readonly string[]): Promise<ReadablePages>;
  /**
   * Whether this actor is inside a Space's readership. An unrestricted Space is readable by any
   * member; a restricted one only by the Principals it names.
   */
  canReadSpace(userId: string | undefined, spaceId: string): Promise<boolean>;
  /**
   * The subset of `spaceIds` this actor may read, in the order given.
   *
   * Batched because listings are the surface that leaks: checking one Space at a time invites a
   * caller to skip the check on a list and filter "later", which is how a restricted Space keeps
   * its name, page count and last-activity on the Knowledge home.
   */
  readableSpaceIds(
    userId: string | undefined,
    spaceIds: readonly string[]
  ): Promise<readonly string[]>;
  canEdit?(userId: string | undefined, subjectKind: "page" | "space", id: string): Promise<boolean>;
  assertDeleteApproved?(
    subjectKind: "page" | "space",
    id: string,
    operationId: string | undefined
  ): Promise<void>;
}

export class PageReadGate implements PageReadAuthorizer {
  private readonly subjects: PgKnowledgeSubjectStore;
  private readonly resolver: PgPrincipalResolver;
  private readonly ownership?: KnowledgeOwnershipPort;

  constructor(
    q: Queryable,
    private readonly businessId: string = DEPLOYMENT_BUSINESS_ID,
    ownership?: KnowledgeOwnershipPort
  ) {
    this.ownership = ownership;
    this.subjects = new PgKnowledgeSubjectStore(q, () => new Date(), ownership);
    this.resolver = new PgPrincipalResolver(q);
  }

  async canEdit(
    userId: string | undefined,
    subjectKind: "page" | "space",
    id: string
  ): Promise<boolean> {
    if (userId === undefined) return false;
    const access = await this.ownership?.accessFor?.(this.businessId, subjectKind, id, userId);
    if (access !== undefined) return access.levels.includes("edit");
    return subjectKind === "page"
      ? await this.canRead(userId, id)
      : await this.canReadSpace(userId, id);
  }

  async assertDeleteApproved(
    subjectKind: "page" | "space",
    id: string,
    operationId: string | undefined
  ): Promise<void> {
    await this.ownership?.consumeDestructiveApproval?.(
      this.businessId,
      subjectKind,
      id,
      operationId
    );
  }

  async canReadSpace(userId: string | undefined, spaceId: string): Promise<boolean> {
    const allowed = await this.readableSpaceIds(userId, [spaceId]);
    return allowed.length === 1;
  }

  async readableSpaceIds(
    userId: string | undefined,
    spaceIds: readonly string[]
  ): Promise<readonly string[]> {
    if (spaceIds.length === 0) return [];
    if (userId === undefined) return [];
    // An id that cannot name a Space is denied here rather than downstream: `subject_id` is `text`,
    // so a malformed id looks *unrestricted* to the query below and sails through to a `uuid`
    // column that raises. Every `/spaces/:id` route gates on this, so one check covers them all.
    // Canonicalized because `subject_id` is `text` and compares case-sensitively, while the `uuid`
    // column that resolves the Space does not. Uncanonicalized, `A0EE…` matches no restriction row,
    // reads as unrestricted, and then resolves to the restricted Space anyway.
    const candidates = spaceIds.filter(isKnowledgeId).map(canonicalKnowledgeId);
    if (candidates.length === 0) return [];

    const principals = await this.resolver.resolve({
      businessId: this.businessId,
      principals: [{ kind: "user", id: userId }],
    });
    const subjects = await this.subjects.getManySpaces(this.businessId, candidates);
    const allowed: string[] = [];
    const now = new Date();
    for (const subject of subjects) {
      const decision = await decideKnowledgeAccess(
        subject,
        { businessId: this.businessId, principals },
        {},
        now
      );
      if (decision.allowed) allowed.push(subject.subjectId);
    }
    return allowed;
  }

  async canRead(userId: string | undefined, pageId: string): Promise<boolean> {
    const { allowed } = await this.readablePageIds(userId, [pageId]);
    return allowed.length === 1;
  }

  /**
   * The subset of `pageIds` this actor may read, in the order given, plus a count of the rest.
   *
   * A withheld Page is absent rather than marked: returning its id — even flagged — would confirm
   * its existence to someone who may not know it exists.
   */
  async readablePageIds(
    userId: string | undefined,
    pageIds: readonly string[]
  ): Promise<ReadablePages> {
    if (pageIds.length === 0) return { allowed: [], excluded: 0 };
    // No identity resolves to no principals, and the gate denies an empty principal set. Returning
    // early only avoids the lookups; it does not change the answer.
    if (userId === undefined) return { allowed: [], excluded: pageIds.length };

    const principals = await this.resolver.resolve({
      businessId: this.businessId,
      principals: [{ kind: "user", id: userId }],
    });
    const now = new Date();
    const subjects = await this.subjects.getManyAuthored(this.businessId, pageIds);
    const allowed: string[] = [];
    for (const subject of subjects) {
      const decision = await decideKnowledgeAccess(
        subject,
        { businessId: this.businessId, principals },
        {},
        now
      );
      if (decision.allowed) allowed.push(subject.subjectId);
    }
    return { allowed, excluded: pageIds.length - allowed.length };
  }
}
