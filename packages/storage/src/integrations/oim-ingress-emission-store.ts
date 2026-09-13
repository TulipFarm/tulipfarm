import type { OimConnection } from "@tulipfarm/schema";
import type { StoreEventInput } from "../events";
import type { TransactionPort } from "../ports";

export const OIM_INGRESS_EMISSION_STORAGE_STATEMENTS = [
  `ALTER TABLE webhook_deliveries
     ADD COLUMN IF NOT EXISTS external_tenant_id text`,
  `ALTER TABLE webhook_deliveries
     ADD COLUMN IF NOT EXISTS external_account_id text`,
  `ALTER TABLE webhook_deliveries
     DROP CONSTRAINT IF EXISTS webhook_deliveries_verified_identity_check`,
  `ALTER TABLE webhook_deliveries
     ADD CONSTRAINT webhook_deliveries_verified_identity_check
     CHECK (
       (external_tenant_id IS NULL AND external_account_id IS NULL)
       OR (external_tenant_id IS NOT NULL AND external_account_id IS NOT NULL)
     )`,
] as const;

export interface OimIngressEmissionInput {
  readonly businessId: string;
  readonly deliveryId: string;
  readonly expectedAttempts: number;
  readonly expectedLeaseExpiresAt: Date;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly event: StoreEventInput;
}

export type OimIngressEmissionResult =
  | { readonly kind: "inserted"; readonly owner: OimConnection["owner"] }
  | { readonly kind: "duplicate"; readonly owner: OimConnection["owner"] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "stale" };

interface ConnectionScopeRow {
  owner_scope: "personal" | "organization" | "team";
  owner_principal_id: string | null;
  owner_team_id: string | null;
}

function ownerOf(row: ConnectionScopeRow): OimConnection["owner"] {
  if (row.owner_scope === "personal" && row.owner_principal_id !== null) {
    return { scope: "personal", principalKind: "user", principalId: row.owner_principal_id };
  }
  if (row.owner_scope === "team" && row.owner_team_id !== null) {
    return { scope: "team", teamId: row.owner_team_id };
  }
  if (row.owner_scope === "organization") return { scope: "organization" };
  throw new Error("invalid_ingress_connection_owner");
}

export class OimIngressEmissionStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly nextId: () => string
  ) {}

  async emitIfAuthorized(input: OimIngressEmissionInput): Promise<OimIngressEmissionResult> {
    if (
      input.event.businessId !== input.businessId ||
      input.event.source.integrationId !== input.integrationId ||
      input.event.source.externalTenantId !== input.externalTenantId ||
      input.event.source.deliveryId !== input.deliveryId ||
      input.event.verification.status !== "verified"
    ) {
      throw new Error("invalid_oim_ingress_event");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const delivery = await transaction.query(
        `SELECT id FROM webhook_deliveries
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND connection_id = $5
            AND external_tenant_id = $6 AND external_account_id = $7
            AND state = 'normalized' AND attempts = $8
            AND lease_expires_at = $9
          FOR UPDATE`,
        [
          input.businessId,
          input.deliveryId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.externalTenantId,
          input.externalAccountId,
          input.expectedAttempts,
          input.expectedLeaseExpiresAt,
        ]
      );
      if (delivery.rows.length !== 1) return { kind: "stale" };

      const connectionLock = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR SHARE`,
        [input.businessId, input.connectionId, input.integrationId, input.integrationMajorVersion]
      );
      if (connectionLock.rows.length !== 1) return { kind: "unauthorized" };

      const connection = await transaction.query<ConnectionScopeRow>(
        `SELECT connection.owner_scope, connection.owner_principal_id, connection.owner_team_id
           FROM connections connection
           JOIN connection_external_identities identity
             ON identity.business_id = connection.business_id
            AND identity.connection_id = connection.id
            AND identity.integration_id = connection.integration_id
            AND identity.integration_major_version = connection.integration_major_version
          WHERE connection.business_id = $1 AND connection.id = $2
            AND connection.integration_id = $3
            AND connection.integration_major_version = $4
            AND connection.status = 'active'
            AND connection.health_status IN ('healthy', 'expiring')
            AND (connection.expires_at IS NULL OR connection.expires_at > now())
            AND identity.external_tenant_id = $5 AND identity.external_account_id = $6
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns teardown
               WHERE teardown.business_id = connection.business_id
                 AND teardown.connection_id = connection.id
            )`,
        [
          input.businessId,
          input.connectionId,
          input.integrationId,
          input.integrationMajorVersion,
          input.externalTenantId,
          input.externalAccountId,
        ]
      );
      const scope = connection.rows[0];
      if (scope === undefined) return { kind: "unauthorized" };

      const sourceKey = JSON.stringify([
        input.event.source.provider,
        input.integrationId,
        input.integrationMajorVersion,
        input.connectionId,
        input.externalTenantId,
        input.externalAccountId,
      ]);
      const inboxId = this.nextId();
      const inserted = await transaction.query(
        `INSERT INTO events_inbox (
           id, business_id, source_key, deduplication_key, event_id, canonical_event,
           raw_artifact_id, raw_payload_hash, verification_status, received_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'verified', $9::timestamptz)
         ON CONFLICT (business_id, source_key, deduplication_key) DO NOTHING
         RETURNING id`,
        [
          inboxId,
          input.businessId,
          sourceKey,
          input.event.deduplicationKey,
          input.event.eventId,
          JSON.stringify(input.event),
          input.event.rawArtifactId ?? null,
          input.event.rawPayloadHash ?? null,
          input.event.receivedAt,
        ]
      );
      const accepted = inserted.rows.length === 1;
      if (accepted) {
        await transaction.query(
          `INSERT INTO outbox_messages (
             id, business_id, inbox_id, topic, payload, created_at
           ) VALUES ($1, $2, $3, 'event.accepted', $4::jsonb, $5::timestamptz)`,
          [
            this.nextId(),
            input.businessId,
            inboxId,
            JSON.stringify({ inboxId, eventId: input.event.eventId }),
            input.event.receivedAt,
          ]
        );
      }
      const dispatched = await transaction.query(
        `UPDATE webhook_deliveries
            SET state = 'dispatched', lease_expires_at = NULL
          WHERE business_id = $1 AND id = $2
            AND state = 'normalized' AND attempts = $3 AND lease_expires_at = $4
          RETURNING id`,
        [input.businessId, input.deliveryId, input.expectedAttempts, input.expectedLeaseExpiresAt]
      );
      if (dispatched.rows.length !== 1) throw new Error("oim_ingress_delivery_fence_lost");
      return { kind: accepted ? "inserted" : "duplicate", owner: ownerOf(scope) };
    });
  }
}
