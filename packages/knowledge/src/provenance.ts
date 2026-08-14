/**
 * Synthesis reauthorizes every cited revision; one failed citation denies the conclusion and
 * reveals only a reason code, not the source name.
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
