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
  get(grantId: string): Promise<RecertificationDueRecord | undefined>;
  put(record: RecertificationDueRecord): Promise<void>;
  /** All records due at or before `at`, regardless of business. */
  listDue(at: Date): Promise<RecertificationDueRecord[]>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link RecertificationRepo} contract.
 */
export class InMemoryRecertificationRepo implements RecertificationRepo {
  private readonly records = new Map<string, RecertificationDueRecord>();

  async get(grantId: string): Promise<RecertificationDueRecord | undefined> {
    return this.records.get(grantId);
  }

  async put(record: RecertificationDueRecord): Promise<void> {
    this.records.set(record.grantId, Object.freeze({ ...record }));
  }

  async listDue(at: Date): Promise<RecertificationDueRecord[]> {
    return [...this.records.values()].filter((r) => r.dueAt <= at);
  }
}
