import { type OimConnection, validateOimConnection } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";
import {
  type BindVerifiedConnectionExternalIdentity,
  bindVerifiedConnectionExternalIdentity,
} from "./connection-external-identity-store";

export interface PersistedConnection extends OimConnection {
  readonly businessId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ConnectionIdentityConflictError extends Error {
  constructor(id: string) {
    super(`Connection ${id} cannot be rebound to another Integration or owner`);
    this.name = "ConnectionIdentityConflictError";
  }
}

export interface ConnectionAuthStepFence {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integration: OimConnection["integration"];
  readonly owner: OimConnection["owner"];
  readonly stepId: string;
  readonly expectedRevision: number;
  readonly healthCheckedAt: string;
}

export interface PublishConnectionAuthStep extends ConnectionAuthStepFence {
  readonly status: "active" | "action_required";
  readonly accessSlot: string | null;
  readonly accessSecretRef: string | null;
  readonly refreshSlot: string | null;
  readonly refreshSecretRef: string | null;
  readonly externalIdentity: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: string | null;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly secretBindings: Readonly<Record<string, `secret://${string}`>>;
  readonly verifiedIdentity?: BindVerifiedConnectionExternalIdentity;
}

export const CONNECTION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connections (
    business_id                 text NOT NULL,
    id                          text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    label                       text NOT NULL,
    owner_scope                 text NOT NULL
      CONSTRAINT connections_owner_scope_check
      CHECK (owner_scope IN ('personal', 'organization', 'team')),
    owner_principal_id          text,
    owner_team_id               text,
    status                      text NOT NULL CHECK (status IN ('active', 'revoked')),
    is_default                  boolean NOT NULL DEFAULT false,
    configuration               jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
    agent_visible_configuration text[] NOT NULL DEFAULT '{}',
    secret_bindings             jsonb NOT NULL CHECK (jsonb_typeof(secret_bindings) = 'object'),
    webhook_registration        jsonb
      CHECK (webhook_registration IS NULL OR jsonb_typeof(webhook_registration) = 'object'),
    health_status               text NOT NULL
      CHECK (health_status IN ('healthy', 'expiring', 'action_required', 'unknown')),
    health_checked_at           timestamptz,
    expires_at                  timestamptz,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id),
    CONSTRAINT connections_route_identity_key UNIQUE (
      business_id, id, integration_id, integration_major_version
    ),
    CONSTRAINT connections_owner_identity_check CHECK (
      (owner_scope = 'personal' AND owner_principal_id IS NOT NULL AND owner_team_id IS NULL)
      OR (owner_scope = 'organization' AND owner_principal_id IS NULL AND owner_team_id IS NULL)
      OR (owner_scope = 'team' AND owner_principal_id IS NULL AND owner_team_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connections_active_default_idx
     ON connections (
       business_id,
       integration_id,
       integration_major_version,
       owner_scope,
       COALESCE(owner_principal_id, ''),
       COALESCE(owner_team_id, '')
     )
     WHERE is_default = true AND status = 'active'`,
  `CREATE INDEX IF NOT EXISTS connections_owner_lookup_idx
     ON connections (
       business_id,
       integration_id,
       integration_major_version,
       owner_scope,
       owner_principal_id,
       owner_team_id,
       status
     )`,
];

interface ConnectionRow {
  business_id: string;
  id: string;
  integration_id: string;
  integration_major_version: number;
  label: string;
  owner_scope: "personal" | "organization" | "team";
  owner_principal_id: string | null;
  owner_team_id: string | null;
  status: OimConnection["status"];
  is_default: boolean;
  configuration: OimConnection["configuration"];
  agent_visible_configuration: string[];
  secret_bindings: OimConnection["secretBindings"];
  webhook_registration: OimConnection["webhookRegistration"] | null;
  health_status: OimConnection["health"]["status"];
  health_checked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: ConnectionRow): PersistedConnection {
  const owner: OimConnection["owner"] =
    row.owner_scope === "personal"
      ? {
          scope: "personal",
          principalKind: "user",
          principalId: required(row.owner_principal_id, row.id),
        }
      : row.owner_scope === "team"
        ? { scope: "team", teamId: required(row.owner_team_id, row.id) }
        : { scope: "organization" };
  return {
    businessId: row.business_id,
    id: row.id,
    integration: {
      id: row.integration_id,
      majorVersion: row.integration_major_version,
    },
    label: row.label,
    owner,
    status: row.status,
    isDefault: row.is_default,
    configuration: row.configuration,
    agentVisibleConfiguration: row.agent_visible_configuration,
    secretBindings: row.secret_bindings,
    ...(row.webhook_registration === null ? {} : { webhookRegistration: row.webhook_registration }),
    health: {
      status: row.health_status,
      checkedAt: row.health_checked_at?.toISOString() ?? null,
    },
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function required(value: string | null, id: string): string {
  if (value === null) throw new Error(`Connection ${id} has invalid owner storage`);
  return value;
}

function ownerPrincipalId(connection: OimConnection): string | null {
  return connection.owner.scope === "personal" ? connection.owner.principalId : null;
}

function ownerTeamId(connection: OimConnection): string | null {
  return connection.owner.scope === "team" ? connection.owner.teamId : null;
}

function sameOwner(row: ConnectionRow, owner: OimConnection["owner"]): boolean {
  return (
    row.owner_scope === owner.scope &&
    row.owner_principal_id === (owner.scope === "personal" ? owner.principalId : null) &&
    row.owner_team_id === (owner.scope === "team" ? owner.teamId : null)
  );
}

export class ConnectionStore {
  constructor(private readonly transactions: TransactionPort) {}

  async put(businessId: string, input: OimConnection): Promise<void> {
    const connection = validateOimConnection(input);
    if (connection.status === "revoked" && connection.isDefault) {
      throw new Error("a revoked Connection cannot be the default");
    }

    await this.transactions.withTransaction(async (transaction) => {
      if (connection.isDefault && connection.status === "active") {
        await transaction.query(
          `UPDATE connections
              SET is_default = false, updated_at = now()
            WHERE business_id = $1
              AND integration_id = $2
              AND integration_major_version = $3
              AND owner_scope = $4
              AND owner_principal_id IS NOT DISTINCT FROM $5
              AND owner_team_id IS NOT DISTINCT FROM $6
              AND status = 'active'
              AND id <> $7`,
          [
            businessId,
            connection.integration.id,
            connection.integration.majorVersion,
            connection.owner.scope,
            ownerPrincipalId(connection),
            ownerTeamId(connection),
            connection.id,
          ]
        );
      }
      const result = await transaction.query(
        `INSERT INTO connections (
           business_id, id, integration_id, integration_major_version, label,
           owner_scope, owner_principal_id, owner_team_id, status, is_default, configuration,
           agent_visible_configuration, secret_bindings, webhook_registration,
           health_status, health_checked_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb,
           $14::jsonb, $15, $16, $17
         )
         ON CONFLICT (business_id, id) DO UPDATE SET
           label = EXCLUDED.label,
           status = EXCLUDED.status,
           is_default = EXCLUDED.is_default,
           configuration = EXCLUDED.configuration,
           agent_visible_configuration = EXCLUDED.agent_visible_configuration,
           secret_bindings = EXCLUDED.secret_bindings,
           webhook_registration = EXCLUDED.webhook_registration,
           health_status = EXCLUDED.health_status,
           health_checked_at = EXCLUDED.health_checked_at,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         WHERE connections.integration_id = EXCLUDED.integration_id
           AND connections.integration_major_version = EXCLUDED.integration_major_version
           AND connections.owner_scope = EXCLUDED.owner_scope
           AND connections.owner_principal_id IS NOT DISTINCT FROM EXCLUDED.owner_principal_id
           AND connections.owner_team_id IS NOT DISTINCT FROM EXCLUDED.owner_team_id
         RETURNING id`,
        [
          businessId,
          connection.id,
          connection.integration.id,
          connection.integration.majorVersion,
          connection.label,
          connection.owner.scope,
          ownerPrincipalId(connection),
          ownerTeamId(connection),
          connection.status,
          connection.isDefault,
          JSON.stringify(connection.configuration),
          connection.agentVisibleConfiguration,
          JSON.stringify(connection.secretBindings),
          connection.webhookRegistration === undefined
            ? null
            : JSON.stringify(connection.webhookRegistration),
          connection.health.status,
          connection.health.checkedAt,
          connection.expiresAt,
        ]
      );
      if (result.rows.length === 0) throw new ConnectionIdentityConflictError(connection.id);
    });
  }

  async claimAuthStep(input: ConnectionAuthStepFence): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const connectionResult = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.connectionId]
      );
      const connection = connectionResult.rows[0];
      if (
        connection === undefined ||
        connection.status !== "active" ||
        connection.integration_id !== input.integration.id ||
        connection.integration_major_version !== input.integration.majorVersion ||
        !sameOwner(connection, input.owner)
      ) {
        return false;
      }

      const result = await transaction.query(
        `UPDATE connection_auth_steps
            SET status = 'pending',
                health_checked_at = $5,
                revision = revision + 1,
                updated_at = now()
          WHERE business_id = $1
            AND connection_id = $2
            AND step_id = $3
            AND revision = $4
          RETURNING step_id`,
        [
          input.businessId,
          input.connectionId,
          input.stepId,
          input.expectedRevision,
          input.healthCheckedAt,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async publishAuthStep(input: PublishConnectionAuthStep): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const connectionResult = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.connectionId]
      );
      const connection = connectionResult.rows[0];
      if (
        connection === undefined ||
        connection.status !== "active" ||
        connection.integration_id !== input.integration.id ||
        connection.integration_major_version !== input.integration.majorVersion ||
        !sameOwner(connection, input.owner)
      ) {
        return false;
      }

      const stepResult = await transaction.query(
        `UPDATE connection_auth_steps
            SET status = $5,
                access_slot = $6,
                access_secret_ref = $7,
                refresh_slot = $8,
                refresh_secret_ref = $9,
                external_identity = $10::jsonb,
                expires_at = $11,
                health_checked_at = $12,
                revision = revision + 1,
                updated_at = now()
          WHERE business_id = $1
            AND connection_id = $2
            AND step_id = $3
            AND revision = $4
            AND status = 'pending'
          RETURNING step_id`,
        [
          input.businessId,
          input.connectionId,
          input.stepId,
          input.expectedRevision,
          input.status,
          input.accessSlot,
          input.accessSecretRef,
          input.refreshSlot,
          input.refreshSecretRef,
          input.externalIdentity === null ? null : JSON.stringify(input.externalIdentity),
          input.expiresAt,
          input.healthCheckedAt,
        ]
      );
      if (stepResult.rows.length !== 1) return false;

      if (input.verifiedIdentity !== undefined) {
        await bindVerifiedConnectionExternalIdentity(transaction, input.verifiedIdentity);
      }
      const aggregate = await transaction.query<{
        healthy: boolean;
        expires_at: Date | string | null;
      }>(
        `SELECT bool_and(status = 'active') AS healthy, min(expires_at) AS expires_at
           FROM connection_auth_steps
          WHERE business_id = $1 AND connection_id = $2`,
        [input.businessId, input.connectionId]
      );
      const health = aggregate.rows[0]?.healthy === true ? "healthy" : "action_required";
      const expiresAt = aggregate.rows[0]?.expires_at ?? null;
      const updated = await transaction.query(
        `UPDATE connections
            SET configuration = configuration || $3::jsonb,
                secret_bindings = secret_bindings || $4::jsonb,
                health_status = $5,
                health_checked_at = $6,
                expires_at = $7,
                updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status = 'active'
          RETURNING id`,
        [
          input.businessId,
          input.connectionId,
          JSON.stringify(input.configuration),
          JSON.stringify(input.secretBindings),
          health,
          input.healthCheckedAt,
          expiresAt,
        ]
      );
      if (updated.rows.length !== 1) throw new Error("connection_auth_publication_lost");
      return true;
    });
  }

  async fenceRevocation(
    businessId: string,
    connectionId: string
  ): Promise<PersistedConnection | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [businessId, connectionId]
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      let fenced = row;
      if (row.status === "active") {
        const updated = await transaction.query<ConnectionRow>(
          `UPDATE connections
              SET status = 'revoked', is_default = false,
                  health_status = 'action_required', health_checked_at = now(), updated_at = now()
            WHERE business_id = $1 AND id = $2
          RETURNING *`,
          [businessId, connectionId]
        );
        if (updated.rows[0] !== undefined) fenced = updated.rows[0];
        await transaction.query(
          `UPDATE connection_auth_steps
              SET status = 'revoked', revision = revision + 1,
                  health_checked_at = now(), updated_at = now()
            WHERE business_id = $1 AND connection_id = $2 AND status <> 'revoked'`,
          [businessId, connectionId]
        );
      }
      return fromRow(fenced);
    });
  }

  async markActionRequired(
    businessId: string,
    connectionId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"],
    checkedAt: string
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `UPDATE connections
            SET health_status = 'action_required', health_checked_at = $6, updated_at = now()
          WHERE business_id = $1
            AND id = $2
            AND integration_id = $3
            AND integration_major_version = $4
            AND owner_scope = $5
            AND owner_principal_id IS NOT DISTINCT FROM $7
            AND owner_team_id IS NOT DISTINCT FROM $8
            AND status = 'active'
          RETURNING *`,
        [
          businessId,
          connectionId,
          integration.id,
          integration.majorVersion,
          owner.scope,
          checkedAt,
          owner.scope === "personal" ? owner.principalId : null,
          owner.scope === "team" ? owner.teamId : null,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async findById(businessId: string, id: string): Promise<PersistedConnection | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        "SELECT * FROM connections WHERE business_id = $1 AND id = $2",
        [businessId, id]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async findByIdAcrossBusinesses(id: string): Promise<PersistedConnection | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        "SELECT * FROM connections WHERE id = $1",
        [id]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async listForOwner(
    businessId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"]
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND owner_scope = $4
            AND owner_principal_id IS NOT DISTINCT FROM $5
            AND owner_team_id IS NOT DISTINCT FROM $6
          ORDER BY is_default DESC, label, id`,
        [
          businessId,
          integration.id,
          integration.majorVersion,
          owner.scope,
          owner.scope === "personal" ? owner.principalId : null,
          owner.scope === "team" ? owner.teamId : null,
        ]
      );
      return result.rows.map(fromRow);
    });
  }

  async listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
          ORDER BY is_default DESC, label, id`,
        [businessId, integration.id, integration.majorVersion]
      );
      return result.rows.map(fromRow);
    });
  }

  async listPersonalForPrincipal(
    businessId: string,
    principalId: string
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND owner_scope = 'personal'
            AND owner_principal_id = $2
          ORDER BY created_at, id`,
        [businessId, principalId]
      );
      return result.rows.map(fromRow);
    });
  }

  async listExpiring(businessId: string, expiresBefore: string): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND status = 'active'
            AND health_status <> 'action_required'
            AND expires_at IS NOT NULL
            AND expires_at <= $2
          ORDER BY expires_at, id`,
        [businessId, expiresBefore]
      );
      return result.rows.map(fromRow);
    });
  }

  async listActiveWebhookRegistrations(): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE status = 'active' AND webhook_registration IS NOT NULL
          ORDER BY business_id, id`
      );
      return result.rows.map(fromRow);
    });
  }

  async listPollingFallbacks(): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE status = 'active'
            AND health_status <> 'action_required'
            AND webhook_registration IS NULL
          ORDER BY business_id, id`
      );
      return result.rows.map(fromRow);
    });
  }

  async markRevoked(businessId: string, id: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE connections
            SET status = 'revoked', is_default = false, updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status = 'active'
          RETURNING id`,
        [businessId, id]
      );
      return result.rows.length === 1;
    });
  }

  async updateHealth(
    businessId: string,
    id: string,
    health: OimConnection["health"],
    expiresAt: string | null
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE connections
            SET health_status = $3, health_checked_at = $4, expires_at = $5, updated_at = now()
          WHERE business_id = $1 AND id = $2
          RETURNING id`,
        [businessId, id, health.status, health.checkedAt, expiresAt]
      );
      return result.rows.length === 1;
    });
  }
}
