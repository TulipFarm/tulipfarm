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
  get(sid: string): Promise<SessionRecord | undefined>;
  destroy(sid: string): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link SessionRepo} contract.
 */
export class InMemorySessionRepo implements SessionRepo {
  private readonly records = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.records.set(record.sid, Object.freeze({ ...record }));
  }

  async get(sid: string): Promise<SessionRecord | undefined> {
    const record = this.records.get(sid);
    if (!record || record.expiresAt <= new Date()) return undefined;
    return record;
  }

  async destroy(sid: string): Promise<void> {
    this.records.delete(sid);
  }
}
