import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmittedPrincipalRef, KnowledgeIdentityMapPort } from "@tulipfarm/integrations";
import type { ExternalIdentityRepo } from "./external-links";

/**
 * Resolves a Knowledge source adapter's external subject (a Slack member id) to the Tulip
 * principal it maps to, via the same `external_identity_mappings` table the live chat path uses
 * (`resolveExternalIdentity`). No new storage. An unmapped or expired subject returns `undefined`
 * — the adapter drops it from the ACL rather than granting implicit access.
 */
export class ExternalLinkKnowledgeIdentityMap implements KnowledgeIdentityMapPort {
  constructor(private readonly repo: ExternalIdentityRepo) {}

  async resolve(input: {
    readonly businessId: string;
    readonly provider: string;
    readonly externalSubject: string;
  }): Promise<readonly EmittedPrincipalRef[] | undefined> {
    if (input.businessId !== DEPLOYMENT_BUSINESS_ID) return undefined;

    const doc = await this.repo.findMapping(input.provider, input.externalSubject);
    if (!doc) return undefined;
    if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return undefined;

    return [{ kind: "user", id: doc.userId }];
  }
}
