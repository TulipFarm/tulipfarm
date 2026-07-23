/**
 * Persistence for verified external identity mappings (SPEC §12): one provider/externalSubject
 * pair resolves to at most one principal per business. Storage owns the mechanics;
 * `@tulipfarm/authz` owns the mapped/expired/substitution decision.
 */

export interface ExternalIdentityMappingRecord {
  readonly businessId: string;
  readonly provider: string;
  readonly externalSubject: string;
  readonly principalId: string;
  readonly verifiedAt: Date;
  readonly expiresAt?: Date;
}

export interface ExternalIdentityRepo {
  find(
    businessId: string,
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingRecord | undefined>;
  put(record: ExternalIdentityMappingRecord): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link ExternalIdentityRepo} contract.
 */
export class InMemoryExternalIdentityRepo implements ExternalIdentityRepo {
  private readonly records = new Map<string, ExternalIdentityMappingRecord>();

  private key(businessId: string, provider: string, externalSubject: string): string {
    return `${businessId}:${provider}:${externalSubject}`;
  }

  async find(
    businessId: string,
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingRecord | undefined> {
    return this.records.get(this.key(businessId, provider, externalSubject));
  }

  async put(record: ExternalIdentityMappingRecord): Promise<void> {
    this.records.set(
      this.key(record.businessId, record.provider, record.externalSubject),
      Object.freeze({ ...record })
    );
  }
}
