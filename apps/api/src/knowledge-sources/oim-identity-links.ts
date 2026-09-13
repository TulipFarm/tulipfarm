import { type ExternalIdentityRepo, isProvenLink } from "../identity/external-links";

export interface ProvenOimKnowledgeIdentityInput {
  readonly businessId: string;
  readonly provider: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly externalTenantId: string;
  readonly providerId: string;
}

/**
 * Adapts only account-control-proven, tenant-scoped links for OIM Knowledge ACL resolution.
 * Connection proof and exact-major checks remain mandatory in the sync/live-authorization caller.
 */
export class ProvenOimKnowledgeIdentityLinks {
  constructor(
    private readonly identities: ExternalIdentityRepo,
    private readonly now: () => Date = () => new Date()
  ) {}

  async linkedPrincipal(
    input: ProvenOimKnowledgeIdentityInput
  ): Promise<{ readonly kind: "user"; readonly id: string } | undefined> {
    if (input.provider !== input.integrationId) return undefined;
    const mapping = await this.identities.findMapping(
      input.provider,
      input.providerId,
      input.externalTenantId
    );
    if (
      mapping === null ||
      mapping.provider !== input.integrationId ||
      mapping.externalSubject !== input.providerId ||
      mapping.externalTenantId !== input.externalTenantId ||
      !isProvenLink(mapping) ||
      (mapping.expiresAt !== null && mapping.expiresAt <= this.now())
    ) {
      return undefined;
    }
    return { kind: "user", id: mapping.userId };
  }
}
