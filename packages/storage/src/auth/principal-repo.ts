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
  get(id: string): Promise<PrincipalRecord | undefined>;
  put(record: PrincipalRecord): Promise<void>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link PrincipalRepo} contract.
 */
export class InMemoryPrincipalRepo implements PrincipalRepo {
  private readonly records = new Map<string, PrincipalRecord>();

  async get(id: string): Promise<PrincipalRecord | undefined> {
    return this.records.get(id);
  }

  async put(record: PrincipalRecord): Promise<void> {
    this.records.set(record.id, Object.freeze({ ...record }));
  }
}
