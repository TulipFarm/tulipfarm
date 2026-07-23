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
  get(businessId: string, principalId: string): Promise<GuestRecord | undefined>;
  put(record: GuestRecord): Promise<void>;
  revoke(businessId: string, principalId: string): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link GuestRepo} contract.
 */
export class InMemoryGuestRepo implements GuestRepo {
  private readonly records = new Map<string, GuestRecord>();

  private key(businessId: string, principalId: string): string {
    return JSON.stringify([businessId, principalId]);
  }

  async get(businessId: string, principalId: string): Promise<GuestRecord | undefined> {
    return this.records.get(this.key(businessId, principalId));
  }

  async put(record: GuestRecord): Promise<void> {
    this.records.set(this.key(record.businessId, record.principalId), Object.freeze({ ...record }));
  }

  async revoke(businessId: string, principalId: string): Promise<void> {
    const key = this.key(businessId, principalId);
    const existing = this.records.get(key);
    if (!existing) return;
    this.records.set(key, Object.freeze({ ...existing, status: "revoked" }));
  }
}
