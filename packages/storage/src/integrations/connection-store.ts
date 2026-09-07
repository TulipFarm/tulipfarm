import { type OimConnection, validateOimConnection } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";

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

export const CONNECTION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connections (
    business_id                text NOT NULL,
    id                         text NOT NULL,
    integration_id             text NOT NULL,
    integration_major_version  integer NOT NULL CHECK (integration_major_version >= 0),
    label                      text NOT NULL,
    owner_scope                text NOT NULL
      CONSTRAINT connections_owner_scope_check CHECK (owner_scope IN ('personal', 'organization', 'team')),
    owner_principal_id         text,
    owner_team_id              text,
    status                     text NOT NULL CHECK (status IN ('active', 'revoked')),
    is_default                 boolean NOT NULL DEFAULT false,
    configuration              jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
    agent_visible_configuration text[] NOT NULL DEFAULT '{}',
    secret_bindings            jsonb NOT NULL CHECK (jsonb_typeof(secret_bindings) = 'object'),
    webhook_registration       jsonb
      CHECK (webhook_registration IS NULL OR jsonb_typeof(webhook_registration) = 'object'),
    health_status              text NOT NULL
      CHECK (health_status IN ('healthy', 'expiring', 'action_required', 'unknown')),
    health_checked_at          timestamptz,
    expires_at                 timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id),
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

function connectionFromRow(row: ConnectionRow): PersistedConnection {
  let owner: OimConnection["owner"];
  if (row.owner_scope === "personal") {
    if (row.owner_principal_id === null) {
      throw new Error(`personal Connection ${row.id} has no owner`);
    }
    owner = {
      scope: "personal",
      principalKind: "user",
      principalId: row.owner_principal_id,
    };
  } else if (row.owner_scope === "organization") {
    owner = { scope: "organization" };
  } else {
    if (row.owner_team_id === null) {
      throw new Error(`team Connection ${row.id} has no Team owner`);
    }
    owner = { scope: "team", teamId: row.owner_team_id };
  }
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

function ownerId(connection: OimConnection): string | null {
  return connection.owner.scope === "personal" ? connection.owner.principalId : null;
}

function teamId(connection: OimConnection): string | null {
  return connection.owner.scope === "team" ? connection.owner.teamId : null;
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
            ownerId(connection),
            teamId(connection),
            connection.id,
          ]
        );
      }

      const { rows } = await transaction.query(
        `INSERT INTO connections (
           business_id, id, integration_id, integration_major_version, label,
           owner_scope, owner_principal_id, owner_team_id, status, is_default, configuration,
           agent_visible_configuration, secret_bindings, webhook_registration,
           health_status, health_checked_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15, $16, $17
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
          ownerId(connection),
          teamId(connection),
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
      if (rows.length === 0) throw new ConnectionIdentityConflictError(connection.id);
    });
  }

  async findById(businessId: string, id: string): Promise<PersistedConnection | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        "SELECT * FROM connections WHERE business_id = $1 AND id = $2",
        [businessId, id]
      );
      return rows[0] ? connectionFromRow(rows[0]) : null;
    });
  }

  /**
   * Look a Connection up by id alone, for the one caller that has no session: the OAuth callback.
   *
   * The id is a server-minted UUID that only ever appears in a one-use, server-side auth request
   * row, so possessing it already implies the authorization this deployment started. Every other
   * caller has a business and must use `findById`.
   */
  async findByIdAcrossBusinesses(id: string): Promise<PersistedConnection | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        "SELECT * FROM connections WHERE id = $1",
        [id]
      );
      return rows[0] ? connectionFromRow(rows[0]) : null;
    });
  }

  async listForOwner(
    businessId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"]
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
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
      return rows.map(connectionFromRow);
    });
  }

  async listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
          ORDER BY is_default DESC, label, id`,
        [businessId, integration.id, integration.majorVersion]
      );
      return rows.map(connectionFromRow);
    });
  }

  /**
   * Lists all personal Connections for one user, including revoked rows, so user offboarding can
   * safely retry lease revocation without touching organization or Team Connections.
   */
  async listPersonalForPrincipal(
    businessId: string,
    principalId: string
  ): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND owner_scope = 'personal'
            AND owner_principal_id = $2
          ORDER BY created_at, id`,
        [businessId, principalId]
      );
      return rows.map(connectionFromRow);
    });
  }

  /** Active Connections whose recorded OAuth expiry has entered a caller-supplied renewal window. */
  async listExpiring(businessId: string, expiresBefore: string): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE business_id = $1
            AND status = 'active'
            AND health_status <> 'action_required'
            AND expires_at IS NOT NULL
            AND expires_at <= $2
          ORDER BY expires_at, id`,
        [businessId, expiresBefore]
      );
      return rows.map(connectionFromRow);
    });
  }

  /** Active Connections with a provider webhook subscription to reconcile after a public URL move. */
  async listActiveWebhookRegistrations(): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE status = 'active'
            AND webhook_registration IS NOT NULL
          ORDER BY business_id, id`
      );
      return rows.map(connectionFromRow);
    });
  }

  /**
   * Active Connections eligible for polling fallback.
   *
   * A registered webhook always wins. Polling is only for a package without a provider
   * subscription, never a second delivery path for a Connection that already has one.
   */
  async listPollingFallbacks(): Promise<PersistedConnection[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ConnectionRow>(
        `SELECT * FROM connections
          WHERE status = 'active'
            AND health_status <> 'action_required'
            AND webhook_registration IS NULL
          ORDER BY business_id, id`
      );
      return rows.map(connectionFromRow);
    });
  }

  /** Persistence half of revocation; callers choose whether its bound Secrets must be retained. */
  async markRevoked(businessId: string, id: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query(
        `UPDATE connections
            SET status = 'revoked', is_default = false, updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status = 'active'
          RETURNING id`,
        [businessId, id]
      );
      return rows.length > 0;
    });
  }

  async updateHealth(
    businessId: string,
    id: string,
    health: OimConnection["health"],
    expiresAt: string | null
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query(
        `UPDATE connections
            SET health_status = $3,
                health_checked_at = $4,
                expires_at = $5,
                updated_at = now()
          WHERE business_id = $1 AND id = $2
          RETURNING id`,
        [businessId, id, health.status, health.checkedAt, expiresAt]
      );
      return rows.length > 0;
    });
  }
}
