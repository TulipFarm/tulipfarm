/**
 * Knowledge authorization is default-deny before retrieval can disclose metadata. Denial evidence
 * contains stable reason codes only, never provider errors, names, ACLs, principals, or content.
 */

import type { KnowledgePrincipalRef, KnowledgeSourceRecord } from "./source";
import { type KnowledgeAclEntry, type KnowledgeSubject, sourceSubject } from "./subject";

export type SourceAccessDenialReason =
  | "business_mismatch"
  | "source_revoked"
  | "source_deleted"
  | "source_unverifiable"
  | "source_stale"
  | "acl_missing"
  | "acl_stale"
  | "acl_revision_drift"
  | "principal_not_permitted"
  | "live_check_denied"
  | "live_check_unavailable";

export type SourceAccessDecision =
  | { readonly allowed: true; readonly aclRevision: string; readonly mode: "live" | "snapshot" }
  | { readonly allowed: false; readonly reason: SourceAccessDenialReason };

/** Who is asking. A grant held by any listed principal (user, role, guest) suffices. */
export interface SourceAccessRequest {
  readonly businessId: string;
  readonly principals: readonly KnowledgePrincipalRef[];
}

/** `undefined` means the provider could not determine access and must deny. */
export interface LiveSourceAuthorizationPort {
  check(input: {
    readonly businessId: string;
    readonly sourceId: string;
    readonly provider: string;
    readonly externalId: string;
    readonly principals: readonly KnowledgePrincipalRef[];
  }): Promise<{ readonly allowed: boolean; readonly aclRevision?: string } | undefined>;
}

export interface SourceAccessPorts {
  readonly live?: LiveSourceAuthorizationPort;
}

function deny(reason: SourceAccessDenialReason): SourceAccessDecision {
  return { allowed: false, reason };
}

function ageSeconds(capturedAt: string, now: Date): number {
  const captured = Date.parse(capturedAt);
  if (Number.isNaN(captured)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - captured) / 1000;
}

function aclPermits(
  entries: readonly KnowledgeAclEntry[],
  principals: readonly KnowledgePrincipalRef[]
): boolean {
  return matches(entries, principals, "grant");
}

function matches(
  entries: readonly KnowledgeAclEntry[],
  principals: readonly KnowledgePrincipalRef[],
  effect: KnowledgeAclEntry["effect"]
): boolean {
  return entries.some(
    (entry) =>
      entry.effect === effect &&
      entry.capability === "read" &&
      principals.some(
        (held) => held.kind === entry.principal.kind && held.id === entry.principal.id
      )
  );
}

/** Who is asking. A grant held by any listed principal suffices; any matching deny beats them all. */
export interface KnowledgeAccessRequest {
  readonly businessId: string;
  readonly principals: readonly KnowledgePrincipalRef[];
  /**
   * Ceiling on entries evaluated for one subject. Exceeding it denies rather than truncating,
   * because evaluating a prefix of an ACL could skip the deny that would have refused the read.
   */
  readonly maxEntries?: number;
}

export type KnowledgeAccessDecision = SourceAccessDecision;

/**
 * The single Knowledge access decision. Returns the narrowest blocking reason without making the
 * decision more permissive.
 *
 * An explicit deny and an absent grant deliberately share `principal_not_permitted`: distinguishing
 * them would let an asker probe whether a specific deny exists on a document they cannot see.
 */
export async function decideKnowledgeAccess(
  subject: KnowledgeSubject,
  request: KnowledgeAccessRequest,
  ports: SourceAccessPorts,
  now: Date
): Promise<KnowledgeAccessDecision> {
  if (subject.businessId !== request.businessId) return deny("business_mismatch");
  if (subject.status === "deleted") return deny("source_deleted");
  if (subject.status === "revoked") return deny("source_revoked");
  if (subject.verification !== "verified") return deny("source_unverifiable");
  if (request.principals.length === 0) return deny("principal_not_permitted");
  // Shares the coarse reason deliberately: a distinct code would report ACL size to an asker who
  // cannot read the document.
  if (request.maxEntries !== undefined && subject.entries.length > request.maxEntries) {
    return deny("principal_not_permitted");
  }

  if (subject.accessControl.mode === "live") {
    const port = ports.live;
    if (port === undefined) return deny("live_check_unavailable");
    let result: Awaited<ReturnType<LiveSourceAuthorizationPort["check"]>>;
    try {
      result = await port.check({
        businessId: subject.businessId,
        sourceId: subject.subjectId,
        provider: subject.provider,
        externalId: subject.externalId,
        principals: request.principals,
      });
    } catch {
      // The provider error itself is dropped: it routinely embeds the file name or the ACL that
      // caused the failure, and this decision is returned to callers that may not read either.
      return deny("live_check_unavailable");
    }
    if (result === undefined) return deny("live_check_unavailable");
    if (!result.allowed) return deny("live_check_denied");
    // A stored deny still applies: the provider grant is a grant, and deny always wins.
    if (matches(subject.entries, request.principals, "deny")) {
      return deny("principal_not_permitted");
    }
    return { allowed: true, aclRevision: result.aclRevision ?? subject.revision, mode: "live" };
  }

  const acl = subject.acl;
  if (acl === undefined) return deny("acl_missing");
  if (acl.aclRevision !== subject.accessControl.aclRevision) return deny("acl_revision_drift");
  if (ageSeconds(acl.capturedAt, now) > subject.accessControl.maximumAgeSeconds) {
    return deny("acl_stale");
  }
  if (matches(subject.entries, request.principals, "deny")) return deny("principal_not_permitted");
  if (!aclPermits(subject.entries, request.principals)) return deny("principal_not_permitted");
  return { allowed: true, aclRevision: acl.aclRevision, mode: "snapshot" };
}

/**
 * Source access is the Knowledge gate applied to a projected source record. Retained with its exact
 * signature so every existing caller and its security suite are unaffected.
 */
export async function decideSourceAccess(
  source: KnowledgeSourceRecord,
  request: SourceAccessRequest,
  ports: SourceAccessPorts,
  now: Date
): Promise<SourceAccessDecision> {
  return decideKnowledgeAccess(sourceSubject(source), request, ports, now);
}

/**
 * Whether a subject may contribute to something shown to everyone — a GraphRAG community summary.
 *
 * Deliberately far stricter than "this principal may read it". A summary is derived text that no
 * per-principal check can un-mix afterwards, so it may only be built over material that is readable
 * by *construction*: an explicit blanket grant, and not one single deny anywhere on the subject. A
 * deny means somebody is excluded, and a summary cannot exclude them from a sentence.
 *
 * Live-mode subjects can never qualify. Their audience is whatever the provider says at query time,
 * so there is no build-time fact to rely on.
 */
export function isBroadlyReadable(
  subject: KnowledgeSubject,
  blanketPrincipals: readonly KnowledgePrincipalRef[],
  now: Date
): boolean {
  if (blanketPrincipals.length === 0) return false;
  if (subject.status !== "active") return false;
  if (subject.verification !== "verified") return false;
  if (subject.accessControl.mode !== "snapshot") return false;
  // The same freshness checks `decideKnowledgeAccess` applies. Without them the build gate would be
  // *looser* than the query gate in one dimension: a snapshot the system has already declared
  // untrustworthy — missing, drifted or aged out — would still be treated as proof of a grant.
  const acl = subject.acl;
  if (acl === undefined) return false;
  if (acl.aclRevision !== subject.accessControl.aclRevision) return false;
  if (ageSeconds(acl.capturedAt, now) > subject.accessControl.maximumAgeSeconds) return false;
  if (subject.entries.some((e) => e.effect === "deny")) return false;
  return matches(subject.entries, blanketPrincipals, "grant");
}
