/**
 * Persistence for periodic access review records (SPEC §12). Storage owns the mechanics;
 * `@tulipfarm/authz` owns the overdue/self-review decision.
 */

export interface RecertificationDueRecord {
  readonly principalId: string;
  readonly businessId: string;
  readonly grantId: string;
  readonly dueAt: Date;
  readonly reviewedAt?: Date;
  readonly reviewerPrincipalId?: string;
}

export interface RecertificationRepo {
  get(businessId: string, grantId: string): Promise<RecertificationDueRecord | undefined>;
  put(record: RecertificationDueRecord): Promise<void>;
  /** Records for one business due at or before `at`. */
  listDue(businessId: string, at: Date): Promise<RecertificationDueRecord[]>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link RecertificationRepo} contract.
 */
export class InMemoryRecertificationRepo implements RecertificationRepo {
  private readonly records = new Map<string, RecertificationDueRecord>();

  private key(businessId: string, grantId: string): string {
    return JSON.stringify([businessId, grantId]);
  }

  async get(businessId: string, grantId: string): Promise<RecertificationDueRecord | undefined> {
    return this.records.get(this.key(businessId, grantId));
  }

  async put(record: RecertificationDueRecord): Promise<void> {
    this.records.set(this.key(record.businessId, record.grantId), Object.freeze({ ...record }));
  }

  async listDue(businessId: string, at: Date): Promise<RecertificationDueRecord[]> {
    return [...this.records.values()].filter(
      (record) => record.businessId === businessId && record.dueAt <= at
    );
  }
}
