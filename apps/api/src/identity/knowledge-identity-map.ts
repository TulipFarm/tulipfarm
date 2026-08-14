import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmittedPrincipalRef, KnowledgeIdentityMapPort } from "@tulipfarm/integrations";
import type { ExternalIdentityRepo } from "./external-links";

/** Maps external Knowledge subjects to Tulip principals; unmapped subjects grant no access. */
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
