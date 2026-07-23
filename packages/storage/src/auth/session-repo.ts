/**
 * Session persistence scoped to business_id (SPEC §12). Storage owns the mechanics; expiry
 * itself is enforced here (`get` never returns an expired row) so every caller sees the same
 * durable truth regardless of adapter.
 */

export interface SessionRecord {
  readonly sid: string;
  readonly principalId: string;
  readonly businessId: string;
  readonly expiresAt: Date;
}

export interface SessionRepo {
  create(record: SessionRecord): Promise<void>;
  /** Returns undefined once past `expiresAt`, even if the row has not been reaped yet. */
  get(businessId: string, sid: string, now: Date): Promise<SessionRecord | undefined>;
  destroy(businessId: string, sid: string): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link SessionRepo} contract.
 */
export class InMemorySessionRepo implements SessionRepo {
  private readonly records = new Map<string, SessionRecord>();

  private key(businessId: string, sid: string): string {
    return JSON.stringify([businessId, sid]);
  }

  async create(record: SessionRecord): Promise<void> {
    this.records.set(this.key(record.businessId, record.sid), Object.freeze({ ...record }));
  }

  async get(businessId: string, sid: string, now: Date): Promise<SessionRecord | undefined> {
    const record = this.records.get(this.key(businessId, sid));
    if (!record || record.expiresAt <= now) return undefined;
    return record;
  }

  async destroy(businessId: string, sid: string): Promise<void> {
    this.records.delete(this.key(businessId, sid));
  }
}
