/**
 * Persistence for sponsored, expiring guest principals (SPEC §12). Storage owns the mechanics;
 * `@tulipfarm/authz` owns the active/expired/revoked/sponsor decision.
 */

import type { GrantRecord } from "./role-repo";

export type GuestStatus = "active" | "revoked";

export interface GuestRecord {
  readonly principalId: string;
  readonly businessId: string;
  readonly sponsorPrincipalId: string;
  readonly expiresAt: Date;
  readonly grants: readonly GrantRecord[];
  readonly status: GuestStatus;
}

export interface GuestRepo {
  get(principalId: string): Promise<GuestRecord | undefined>;
  put(record: GuestRecord): Promise<void>;
  revoke(principalId: string): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link GuestRepo} contract.
 */
export class InMemoryGuestRepo implements GuestRepo {
  private readonly records = new Map<string, GuestRecord>();

  async get(principalId: string): Promise<GuestRecord | undefined> {
    return this.records.get(principalId);
  }

  async put(record: GuestRecord): Promise<void> {
    this.records.set(record.principalId, Object.freeze({ ...record }));
  }

  async revoke(principalId: string): Promise<void> {
    const existing = this.records.get(principalId);
    if (!existing) return;
    this.records.set(principalId, Object.freeze({ ...existing, status: "revoked" }));
  }
}
