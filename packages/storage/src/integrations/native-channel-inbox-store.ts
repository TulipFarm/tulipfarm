import { ambientTransactionPort } from "../pg/transaction-helpers";
import type { Queryable, TransactionPort } from "../ports";

export interface NativeChannelInboxInput {
  readonly id: string;
  readonly businessId: string;
  readonly provider: "slack" | "github";
  readonly integrationId: string;
  readonly externalAppId: string;
  readonly externalTenantId: string;
  readonly deliveryId: string;
  readonly payloadDigest: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly binding: Record<string, unknown>;
}

export interface NativeChannelInboxRecord extends NativeChannelInboxInput {
  readonly status: "accepted" | "dispatching" | "dispatched" | "denied";
  readonly attempts: number;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly runId: string | null;
}

export interface NativeChannelRoutineRoute {
  readonly id: string;
  readonly businessId: string;
  readonly provider: "slack" | "github";
  readonly integrationId: string;
  readonly destination: string;
  readonly eventType: string;
  readonly routineId: string;
  readonly enabled: boolean;
  readonly authority: {
    readonly definitionRef: string;
    readonly principal: { readonly kind: string; readonly id: string };
    readonly configurationDigest: string;
  } | null;
}

export const NATIVE_CHANNEL_INBOX_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS native_channel_inbox (
    id text PRIMARY KEY,
    business_id text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('slack', 'github')),
    integration_id text NOT NULL,
    external_app_id text NOT NULL,
    external_tenant_id text NOT NULL,
    delivery_id text NOT NULL,
    payload_digest text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    binding jsonb NOT NULL,
    status text NOT NULL DEFAULT 'accepted'
      CHECK (status IN ('accepted', 'dispatching', 'dispatched', 'denied')),
    attempts integer NOT NULL DEFAULT 0,
    lease_token text,
    lease_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    run_id text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, provider, external_app_id, external_tenant_id, delivery_id),
    UNIQUE (business_id, provider, external_app_id, external_tenant_id, payload_digest)
  )`,
  `CREATE INDEX IF NOT EXISTS native_channel_inbox_due_idx
    ON native_channel_inbox (business_id, next_attempt_at)
    WHERE status IN ('accepted', 'dispatching')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS native_channel_inbox_run_idx
    ON native_channel_inbox (business_id, run_id) WHERE run_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS native_channel_routine_routes (
    business_id text NOT NULL,
    id text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('slack', 'github')),
    integration_id text NOT NULL,
    destination text NOT NULL,
    event_type text NOT NULL,
    routine_id text NOT NULL,
    enabled boolean NOT NULL,
    authority jsonb,
    PRIMARY KEY (business_id, id),
    UNIQUE (business_id, provider, integration_id, destination, event_type)
  )`,
  `ALTER TABLE native_channel_routine_routes ALTER COLUMN authority DROP NOT NULL`,
  `ALTER TABLE native_channel_routine_routes
    DROP CONSTRAINT IF EXISTS native_channel_routine_routes_authority_check`,
  `ALTER TABLE native_channel_routine_routes
    ADD CONSTRAINT native_channel_routine_routes_authority_check
    CHECK (NOT enabled OR (authority IS NOT NULL AND jsonb_typeof(authority) = 'object'))`,
];

interface Row {
  id: string;
  business_id: string;
  provider: "slack" | "github";
  integration_id: string;
  external_app_id: string;
  external_tenant_id: string;
  delivery_id: string;
  payload_digest: string;
  event_type: string;
  payload: Record<string, unknown>;
  binding: Record<string, unknown>;
  status: NativeChannelInboxRecord["status"];
  attempts: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  run_id: string | null;
}

function record(row: Row): NativeChannelInboxRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    integrationId: row.integration_id,
    externalAppId: row.external_app_id,
    externalTenantId: row.external_tenant_id,
    deliveryId: row.delivery_id,
    payloadDigest: row.payload_digest,
    eventType: row.event_type,
    payload: row.payload,
    binding: row.binding,
    status: row.status,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    leaseExpiresAt:
      row.lease_expires_at instanceof Date
        ? row.lease_expires_at.toISOString()
        : row.lease_expires_at,
    runId: row.run_id,
  };
}

export class NativeChannelInboxStore {
  constructor(private readonly transactions: TransactionPort) {}

  async putRoutineRoute(route: NativeChannelRoutineRoute): Promise<void> {
    await this.transactions.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO native_channel_routine_routes (
          business_id,id,provider,integration_id,destination,event_type,routine_id,enabled,authority
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT (business_id,provider,integration_id,destination,event_type) DO UPDATE
          SET routine_id=EXCLUDED.routine_id,enabled=EXCLUDED.enabled,authority=EXCLUDED.authority`,
        [
          route.businessId,
          route.id,
          route.provider,
          route.integrationId,
          route.destination,
          route.eventType,
          route.routineId,
          route.enabled,
          route.authority === null ? null : JSON.stringify(route.authority),
        ]
      );
    });
  }

  async routineRoutes(
    businessId: string,
    provider: "slack" | "github"
  ): Promise<NativeChannelRoutineRoute[]> {
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        business_id: string;
        provider: "slack" | "github";
        integration_id: string;
        destination: string;
        event_type: string;
        routine_id: string;
        enabled: boolean;
        authority: NativeChannelRoutineRoute["authority"];
      }>(
        "SELECT * FROM native_channel_routine_routes WHERE business_id=$1 AND provider=$2 ORDER BY id",
        [businessId, provider]
      );
      return result.rows.map((row) => ({
        id: row.id,
        businessId: row.business_id,
        provider: row.provider,
        integrationId: row.integration_id,
        destination: row.destination,
        eventType: row.event_type,
        routineId: row.routine_id,
        enabled: row.enabled,
        authority: row.authority,
      }));
    });
  }

  async accept(input: NativeChannelInboxInput): Promise<{
    readonly outcome: "accepted" | "duplicate";
    readonly event: NativeChannelInboxRecord;
  }> {
    return this.transactions.withTransaction(async (tx) => {
      const inserted = await tx.query<Row>(
        `INSERT INTO native_channel_inbox (
          id, business_id, provider, integration_id, external_app_id, external_tenant_id,
          delivery_id, payload_digest, event_type, payload, binding
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
        ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.id,
          input.businessId,
          input.provider,
          input.integrationId,
          input.externalAppId,
          input.externalTenantId,
          input.deliveryId,
          input.payloadDigest,
          input.eventType,
          JSON.stringify(input.payload),
          JSON.stringify(input.binding),
        ]
      );
      if (inserted.rows[0]) return { outcome: "accepted", event: record(inserted.rows[0]) };
      const existing = await tx.query<Row>(
        `SELECT * FROM native_channel_inbox WHERE business_id=$1 AND provider=$2
          AND external_app_id=$3 AND external_tenant_id=$4
          AND (delivery_id=$5 OR payload_digest=$6)`,
        [
          input.businessId,
          input.provider,
          input.externalAppId,
          input.externalTenantId,
          input.deliveryId,
          input.payloadDigest,
        ]
      );
      if (existing.rows.length !== 1 || existing.rows[0].payload_digest !== input.payloadDigest) {
        throw new Error("native_delivery_conflict");
      }
      return { outcome: "duplicate", event: record(existing.rows[0]) };
    });
  }

  async claim(
    businessId: string,
    leaseToken: string,
    limit: number,
    now = new Date()
  ): Promise<readonly NativeChannelInboxRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("native_claim_limit_invalid");
    }
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<Row>(
        `WITH due AS (
          SELECT id FROM native_channel_inbox WHERE business_id=$1
            AND ((status='accepted' AND next_attempt_at <= $4)
              OR (status='dispatching' AND lease_expires_at <= $4))
          ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED
        )
        UPDATE native_channel_inbox i SET status='dispatching',lease_token=$2,
          lease_expires_at=$4::timestamptz + interval '120 seconds',
          attempts=i.attempts+1,updated_at=$4
        FROM due WHERE i.id=due.id RETURNING i.*`,
        [businessId, leaseToken, limit, now.toISOString()]
      );
      return result.rows.map(record);
    });
  }

  async finish(
    event: NativeChannelInboxRecord,
    result: { readonly status: "dispatched" | "denied" | "retry"; readonly code?: string },
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (tx) => {
      const status =
        result.status === "retry" ? (event.attempts >= 20 ? "denied" : "accepted") : result.status;
      const updated = await tx.query(
        `UPDATE native_channel_inbox SET status=$4,last_error=$5,lease_token=NULL,
          lease_expires_at=NULL,next_attempt_at=$6::timestamptz + interval '10 seconds',updated_at=$6
        WHERE business_id=$1 AND id=$2 AND status='dispatching' AND lease_token=$3
          AND lease_expires_at > $6 RETURNING id`,
        [
          event.businessId,
          event.id,
          event.leaseToken,
          status,
          result.code ?? null,
          now.toISOString(),
        ]
      );
      return updated.rows.length === 1;
    });
  }

  async bindRun(
    event: NativeChannelInboxRecord,
    runId: string,
    now = new Date(),
    transaction?: Queryable
  ): Promise<void> {
    const transactions =
      transaction === undefined ? this.transactions : ambientTransactionPort(transaction);
    await transactions.withTransaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE native_channel_inbox SET run_id=$4 WHERE business_id=$1 AND id=$2
          AND status='dispatching' AND lease_token=$3 AND lease_expires_at > $5
          AND (run_id IS NULL OR run_id=$4) RETURNING id`,
        [event.businessId, event.id, event.leaseToken, runId, now.toISOString()]
      );
      if (updated.rows.length !== 1) throw new Error("native_delivery_lease_lost");
    });
  }

  async assertClaim(event: NativeChannelInboxRecord, now = new Date()): Promise<void> {
    await this.transactions.withTransaction(async (tx) => {
      const owned = await tx.query(
        `SELECT id FROM native_channel_inbox WHERE business_id=$1 AND id=$2
          AND status='dispatching' AND lease_token=$3 AND lease_expires_at > $4`,
        [event.businessId, event.id, event.leaseToken, now.toISOString()]
      );
      if (owned.rows.length !== 1) throw new Error("native_delivery_lease_lost");
    });
  }

  async findByRun(
    businessId: string,
    runId: string
  ): Promise<NativeChannelInboxRecord | undefined> {
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<Row>(
        "SELECT * FROM native_channel_inbox WHERE business_id=$1 AND run_id=$2",
        [businessId, runId]
      );
      return result.rows[0] ? record(result.rows[0]) : undefined;
    });
  }

  async find(businessId: string, id: string): Promise<NativeChannelInboxRecord | undefined> {
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<Row>(
        "SELECT * FROM native_channel_inbox WHERE business_id=$1 AND id=$2",
        [businessId, id]
      );
      return result.rows[0] ? record(result.rows[0]) : undefined;
    });
  }
}
