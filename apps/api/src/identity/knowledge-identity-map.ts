import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  EmittedPrincipalRef,
  KnowledgeIdentityMapPort,
  ProviderIdentityLinkPort,
} from "@tulipfarm/integrations";
import { type ExternalIdentityRepo, isProvenLink } from "./external-links";

export { PROVEN_LINK_VERIFICATION } from "./external-links";

/** Maps external Knowledge subjects to Tulip principals; unmapped subjects grant no access. */
export class ExternalLinkKnowledgeIdentityMap implements KnowledgeIdentityMapPort {
  constructor(private readonly repo: ExternalIdentityRepo) {}

  async resolve(input: {
    readonly businessId: string;
    readonly provider: string;
    readonly externalSubject: string;
    readonly externalTenantId?: string;
  }): Promise<readonly EmittedPrincipalRef[] | undefined> {
    if (input.businessId !== DEPLOYMENT_BUSINESS_ID) return undefined;

    const doc = await this.repo.findMapping(
      input.provider,
      input.externalSubject,
      input.externalTenantId
    );
    if (!doc) return undefined;
    if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return undefined;
    if (!isProvenLink(doc)) return undefined;

    return [{ kind: "user", id: doc.userId }];
  }
}

/**
 * Narrows the Slack-era identity map to the single-principal port OIM Knowledge asks for.
 *
 * The map may answer with several principals for one provider account; a Knowledge ACL entry names
 * one subject, so the first proven link is the answer and an unlinked account is `undefined` —
 * which drops the grant. Dropping a grant narrows access, so guessing here would be the only
 * dangerous option.
 */
export function providerIdentityLinkPort(map: KnowledgeIdentityMapPort): ProviderIdentityLinkPort {
  return {
    async linkedPrincipal({ businessId, provider, providerId }) {
      const principals = await map.resolve({
        businessId,
        provider,
        externalSubject: providerId,
      });
      return principals?.[0];
    },
  };
}
