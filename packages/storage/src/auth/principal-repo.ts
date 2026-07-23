/**
 * Persistence for the distinct principal kinds SPEC §12 requires — user, Agent, Routine,
 * integration adapter, API, and service — each scoped to a business_id. Storage owns the
 * mechanics; `@tulipfarm/authz` owns the authenticate/substitute decision.
 */

export type PrincipalKind =
  | "user"
  | "agent"
  | "routine"
  | "integration_adapter"
  | "api"
  | "service";

export type PrincipalStatus = "active" | "disabled" | "expired";

export interface PrincipalRecord {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalStatus;
  readonly expiresAt?: Date;
}

export interface PrincipalRepo {
  get(businessId: string, id: string): Promise<PrincipalRecord | undefined>;
  put(record: PrincipalRecord): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link PrincipalRepo} contract.
 */
export class InMemoryPrincipalRepo implements PrincipalRepo {
  private readonly records = new Map<string, PrincipalRecord>();

  private key(businessId: string, id: string): string {
    return JSON.stringify([businessId, id]);
  }

  async get(businessId: string, id: string): Promise<PrincipalRecord | undefined> {
    return this.records.get(this.key(businessId, id));
  }

  async put(record: PrincipalRecord): Promise<void> {
    this.records.set(this.key(record.businessId, record.id), Object.freeze({ ...record }));
  }
}
