/** Principal persistence only; `@tulipfarm/authz` owns authenticate/substitute decisions. */

import type { PrincipalKind as SchemaPrincipalKind } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";

export type PrincipalKind = SchemaPrincipalKind;

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
  /** Lists registered principals so non-human ids are discoverable for grants. */
  list(businessId: string): Promise<readonly PrincipalRecord[]>;
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

  async list(businessId: string): Promise<readonly PrincipalRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.businessId === businessId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

interface PrincipalRow {
  id: string;
  business_id: string;
  kind: PrincipalKind;
  status: PrincipalStatus;
  expires_at: Date | null;
}

function principalFromRow(row: PrincipalRow): PrincipalRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    status: row.status,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

export class PgPrincipalRepo implements PrincipalRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async get(businessId: string, id: string): Promise<PrincipalRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PrincipalRow>(
        `SELECT id, business_id, kind, status, expires_at
           FROM principals
          WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const row = result.rows[0];
      return row ? principalFromRow(row) : undefined;
    });
  }

  async put(record: PrincipalRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO principals (business_id, id, kind, status, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (business_id, id) DO UPDATE SET
           kind = EXCLUDED.kind,
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
        [record.businessId, record.id, record.kind, record.status, record.expiresAt ?? null]
      );
    });
  }

  async list(businessId: string): Promise<readonly PrincipalRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PrincipalRow>(
        `SELECT id, business_id, kind, status, expires_at
           FROM principals
          WHERE business_id = $1
          ORDER BY id`,
        [businessId]
      );
      return result.rows.map(principalFromRow);
    });
  }
}
