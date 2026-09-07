/** Stores one verified provider/externalSubject mapping per principal/business pair. */

export interface ExternalIdentityMappingRecord {
  readonly businessId: string;
  readonly provider: string;
  readonly externalSubject: string;
  readonly externalTenantId?: string;
  readonly principalId: string;
  readonly verifiedAt: Date;
  readonly expiresAt?: Date;
}

export interface ExternalIdentityRepo {
  find(
    businessId: string,
    provider: string,
    externalSubject: string,
    externalTenantId?: string
  ): Promise<ExternalIdentityMappingRecord | undefined>;
  put(record: ExternalIdentityMappingRecord): Promise<void>;
}

/** Process-local ExternalIdentityRepo double; durable adapters implement the same contract. */
export class InMemoryExternalIdentityRepo implements ExternalIdentityRepo {
  private readonly records = new Map<string, ExternalIdentityMappingRecord>();

  private key(
    businessId: string,
    provider: string,
    externalSubject: string,
    externalTenantId?: string
  ): string {
    return `${businessId}:${provider}:${externalTenantId ?? ""}:${externalSubject}`;
  }

  async find(
    businessId: string,
    provider: string,
    externalSubject: string,
    externalTenantId?: string
  ): Promise<ExternalIdentityMappingRecord | undefined> {
    return this.records.get(this.key(businessId, provider, externalSubject, externalTenantId));
  }

  async put(record: ExternalIdentityMappingRecord): Promise<void> {
    this.records.set(
      this.key(record.businessId, record.provider, record.externalSubject, record.externalTenantId),
      Object.freeze({ ...record })
    );
  }
}
