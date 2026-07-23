/**
 * Persistence for issued just-in-time grants (SPEC §12). Storage owns the mechanics;
 * `@tulipfarm/authz` owns the expiry/separation-of-duties decision at issuance time.
 */

import type { GrantRecord } from "./role-repo";

export interface JitGrantIssuanceRecord {
  readonly id: string;
  readonly principalId: string;
  readonly businessId: string;
  readonly grant: GrantRecord;
  readonly approverPrincipalId: string;
  readonly justification: string;
  readonly issuedAt: Date;
}

export interface JitGrantRepo {
  put(record: JitGrantIssuanceRecord): Promise<void>;
  /** Only unexpired grants, even if expired rows have not been reaped yet. */
  listActive(businessId: string, principalId: string, now: Date): Promise<JitGrantIssuanceRecord[]>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link JitGrantRepo} contract.
 */
export class InMemoryJitGrantRepo implements JitGrantRepo {
  private readonly records: JitGrantIssuanceRecord[] = [];

  async put(record: JitGrantIssuanceRecord): Promise<void> {
    this.records.push(Object.freeze({ ...record }));
  }

  async listActive(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<JitGrantIssuanceRecord[]> {
    return this.records.filter(
      (r) =>
        r.businessId === businessId &&
        r.principalId === principalId &&
        (!r.grant.expiresAt || r.grant.expiresAt > now)
    );
  }
}
