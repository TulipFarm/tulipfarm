/**
 * Provenance-authorized synthesis (SPEC §14.1: "a conclusion drawn from multiple sources requires
 * that every supporting source is authorized for the requester").
 *
 * Retrieval authorized each candidate when it was fetched. That is not enough to *state* a
 * conclusion: time has passed, a source may have been revoked, its content may have moved on, and
 * a synthesis blends sources so that no reader can tell which one a sentence came from. So every
 * citation is reauthorized at its cited revision, and a single failure denies the whole conclusion
 * rather than silently dropping one input — a conclusion missing one of its supports is not the
 * same conclusion.
 *
 * The denial carries a reason code and nothing else. Naming the source that failed would disclose
 * exactly the document the ACL withheld.
 */

import type { SourceAccessDenialReason } from "./acl";
import { decideSourceAccess, type LiveSourceAuthorizationPort } from "./acl";
import type { RetrievalCitation } from "./retrieve";
import type { KnowledgePrincipalRef, KnowledgeSourceStore } from "./source";

export type SynthesisDenialReason =
  | SourceAccessDenialReason
  | "source_missing"
  | "citation_revision_drift"
  | "citation_acl_drift"
  | "no_citations";

export type SynthesisDecision =
  | { readonly allowed: true; readonly citations: readonly RetrievalCitation[] }
  | { readonly allowed: false; readonly reason: SynthesisDenialReason };

export interface SynthesisRequest {
  readonly businessId: string;
  readonly principals: readonly KnowledgePrincipalRef[];
  readonly citations: readonly RetrievalCitation[];
}

export interface SynthesisDeps {
  readonly sources: KnowledgeSourceStore;
  readonly live?: LiveSourceAuthorizationPort;
}

/**
 * Authorize a cross-source conclusion. Allows only if every cited source still exists, still
 * authorizes for this principal, and is still at the revision and ACL revision that was cited.
 */
export async function authorizeSynthesis(
  deps: SynthesisDeps,
  request: SynthesisRequest,
  now: Date
): Promise<SynthesisDecision> {
  // An unsupported conclusion is not "trivially authorized" — it is unsupported.
  if (request.citations.length === 0) return { allowed: false, reason: "no_citations" };

  for (const citation of request.citations) {
    const source = await deps.sources.get(request.businessId, citation.sourceId);
    if (source === undefined) return { allowed: false, reason: "source_missing" };

    const decision = await decideSourceAccess(
      source,
      { businessId: request.businessId, principals: request.principals },
      { live: deps.live },
      now
    );
    if (!decision.allowed) return { allowed: false, reason: decision.reason };

    // Drift means the answer was built on content or permissions that no longer hold; it must be
    // re-retrieved rather than restated.
    if (source.revision !== citation.revision) {
      return { allowed: false, reason: "citation_revision_drift" };
    }
    if (decision.aclRevision !== citation.aclRevision) {
      return { allowed: false, reason: "citation_acl_drift" };
    }
  }

  return { allowed: true, citations: request.citations };
}
