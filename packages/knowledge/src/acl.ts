/**
 * Source authorization is default-deny before retrieval can disclose metadata. Denial evidence
 * contains stable reason codes only, never provider errors, names, ACLs, principals, or content.
 */

import type { KnowledgeAclSnapshot, KnowledgePrincipalRef, KnowledgeSourceRecord } from "./source";

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
  acl: KnowledgeAclSnapshot,
  principals: readonly KnowledgePrincipalRef[]
): boolean {
  return acl.principals.some((granted) =>
    principals.some((held) => held.kind === granted.kind && held.id === granted.id)
  );
}

/** Returns the narrowest blocking reason without making the decision more permissive. */
export async function decideSourceAccess(
  source: KnowledgeSourceRecord,
  request: SourceAccessRequest,
  ports: SourceAccessPorts,
  now: Date
): Promise<SourceAccessDecision> {
  if (source.businessId !== request.businessId) return deny("business_mismatch");
  if (source.status === "deleted") return deny("source_deleted");
  if (source.status === "revoked") return deny("source_revoked");
  if (source.verification !== "verified") return deny("source_unverifiable");
  if (request.principals.length === 0) return deny("principal_not_permitted");

  if (source.accessControl.mode === "live") {
    const port = ports.live;
    if (port === undefined) return deny("live_check_unavailable");
    let result: Awaited<ReturnType<LiveSourceAuthorizationPort["check"]>>;
    try {
      result = await port.check({
        businessId: source.businessId,
        sourceId: source.sourceId,
        provider: source.provider,
        externalId: source.externalId,
        principals: request.principals,
      });
    } catch {
      // The provider error itself is dropped: it routinely embeds the file name or the ACL that
      // caused the failure, and this decision is returned to callers that may not read either.
      return deny("live_check_unavailable");
    }
    if (result === undefined) return deny("live_check_unavailable");
    if (!result.allowed) return deny("live_check_denied");
    return { allowed: true, aclRevision: result.aclRevision ?? source.revision, mode: "live" };
  }

  const acl = source.acl;
  if (acl === undefined) return deny("acl_missing");
  if (acl.aclRevision !== source.accessControl.aclRevision) return deny("acl_revision_drift");
  if (ageSeconds(acl.capturedAt, now) > source.accessControl.maximumAgeSeconds) {
    return deny("acl_stale");
  }
  if (!aclPermits(acl, request.principals)) return deny("principal_not_permitted");
  return { allowed: true, aclRevision: acl.aclRevision, mode: "snapshot" };
}
