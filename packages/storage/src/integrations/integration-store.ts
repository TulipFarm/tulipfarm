import type { TransactionPort } from "../ports";

export type IntegrationProjectionStatus = "active" | "revoked";

export interface PersistedIntegrationApp {
  id: string;
  businessId: string;
  provider: string;
  externalAppId: string;
  credentialRefs: string[];
  status: IntegrationProjectionStatus;
}

export interface PersistedIntegration {
  id: string;
  businessId: string;
  appId: string;
  externalTenantId: string;
  externalAccountId?: string;
  credentialRef?: string;
  status: IntegrationProjectionStatus;
}

export interface PersistedIntegrationAccessGrant {
  id: string;
  businessId: string;
  integrationId: string;
  definition: unknown;
  status: IntegrationProjectionStatus;
}

export interface PersistedChannelRoute {
  id: string;
  businessId: string;
  integrationId: string;
  agentId: string;
  channelId: string | null;
  threadId: string | null;
  eventTypes: string[];
  priority: number;
  status: IntegrationProjectionStatus;
}

export interface PersistedRoutingSnapshot {
  apps: PersistedIntegrationApp[];
  integrations: PersistedIntegration[];
  accessGrants: PersistedIntegrationAccessGrant[];
  routes: PersistedChannelRoute[];
}

export const INTEGRATION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS integration_apps (
    business_id      text NOT NULL,
    id               text NOT NULL,
    provider         text NOT NULL,
    external_app_id  text NOT NULL,
    credential_refs  jsonb NOT NULL CHECK (jsonb_typeof(credential_refs) = 'array'),
    status            text NOT NULL CHECK (status IN ('active', 'revoked')),
    PRIMARY KEY (business_id, id),
    UNIQUE (business_id, provider, external_app_id)
  )`,
  `CREATE TABLE IF NOT EXISTS integrations (
    business_id         text NOT NULL,
    id                  text NOT NULL,
    app_id              text NOT NULL,
    external_tenant_id  text NOT NULL,
    external_account_id text,
    credential_ref      text,
    status              text NOT NULL CHECK (status IN ('active', 'revoked')),
    PRIMARY KEY (business_id, id),
    UNIQUE (business_id, app_id, external_tenant_id),
    FOREIGN KEY (business_id, app_id) REFERENCES integration_apps(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS integration_access_grants (
    business_id    text NOT NULL,
    id             text NOT NULL,
    integration_id text NOT NULL,
    definition     jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    status         text NOT NULL CHECK (status IN ('active', 'revoked')),
    PRIMARY KEY (business_id, id),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS integration_routes (
    business_id    text NOT NULL,
    id             text NOT NULL,
    integration_id text NOT NULL,
    agent_id        text NOT NULL,
    channel_id      text,
    thread_id       text,
    event_types     jsonb NOT NULL CHECK (jsonb_typeof(event_types) = 'array'),
    priority        integer NOT NULL,
    status          text NOT NULL CHECK (status IN ('active', 'revoked')),
    PRIMARY KEY (business_id, id),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS integration_routes_lookup_idx
    ON integration_routes (business_id, integration_id, status, priority DESC)`,
];

interface AppRow {
  id: string;
  business_id: string;
  provider: string;
  external_app_id: string;
  credential_refs: string[];
  status: IntegrationProjectionStatus;
}

interface IntegrationRow {
  id: string;
  business_id: string;
  app_id: string;
  external_tenant_id: string;
  external_account_id: string | null;
  credential_ref: string | null;
  status: IntegrationProjectionStatus;
}

interface AccessGrantRow {
  id: string;
  business_id: string;
  integration_id: string;
  definition: unknown;
  status: IntegrationProjectionStatus;
}

interface RouteRow {
  id: string;
  business_id: string;
  integration_id: string;
  agent_id: string;
  channel_id: string | null;
  thread_id: string | null;
  event_types: string[];
  priority: number;
  status: IntegrationProjectionStatus;
}

function persistedApp(row: AppRow): PersistedIntegrationApp {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    externalAppId: row.external_app_id,
    credentialRefs: row.credential_refs,
    status: row.status,
  };
}

function persistedIntegration(row: IntegrationRow): PersistedIntegration {
  return {
    id: row.id,
    businessId: row.business_id,
    appId: row.app_id,
    externalTenantId: row.external_tenant_id,
    ...(row.external_account_id === null ? {} : { externalAccountId: row.external_account_id }),
    ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }),
    status: row.status,
  };
}

function persistedAccessGrant(row: AccessGrantRow): PersistedIntegrationAccessGrant {
  return {
    id: row.id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    definition: row.definition,
    status: row.status,
  };
}

function persistedRoute(row: RouteRow): PersistedChannelRoute {
  return {
    id: row.id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    eventTypes: row.event_types,
    priority: row.priority,
    status: row.status,
  };
}

export class IntegrationStore {
  constructor(private readonly transactions: TransactionPort) {}

  async putApp(app: PersistedIntegrationApp): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO integration_apps (
           business_id, id, provider, external_app_id, credential_refs, status
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (business_id, id) DO UPDATE SET
           provider = EXCLUDED.provider,
           external_app_id = EXCLUDED.external_app_id,
           credential_refs = EXCLUDED.credential_refs,
           status = EXCLUDED.status`,
        [
          app.businessId,
          app.id,
          app.provider,
          app.externalAppId,
          JSON.stringify(app.credentialRefs),
          app.status,
        ]
      );
    });
  }

  async putIntegration(integration: PersistedIntegration): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO integrations (
           business_id, id, app_id, external_tenant_id, external_account_id,
           credential_ref, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (business_id, id) DO UPDATE SET
           app_id = EXCLUDED.app_id,
           external_tenant_id = EXCLUDED.external_tenant_id,
           external_account_id = EXCLUDED.external_account_id,
           credential_ref = EXCLUDED.credential_ref,
           status = EXCLUDED.status`,
        [
          integration.businessId,
          integration.id,
          integration.appId,
          integration.externalTenantId,
          integration.externalAccountId ?? null,
          integration.credentialRef ?? null,
          integration.status,
        ]
      );
    });
  }

  async putAccessGrant(grant: PersistedIntegrationAccessGrant): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO integration_access_grants (
           business_id, id, integration_id, definition, status
         ) VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (business_id, id) DO UPDATE SET
           integration_id = EXCLUDED.integration_id,
           definition = EXCLUDED.definition,
           status = EXCLUDED.status`,
        [
          grant.businessId,
          grant.id,
          grant.integrationId,
          JSON.stringify(grant.definition),
          grant.status,
        ]
      );
    });
  }

  async putRoute(route: PersistedChannelRoute): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO integration_routes (
           business_id, id, integration_id, agent_id, channel_id, thread_id,
           event_types, priority, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (business_id, id) DO UPDATE SET
           integration_id = EXCLUDED.integration_id,
           agent_id = EXCLUDED.agent_id,
           channel_id = EXCLUDED.channel_id,
           thread_id = EXCLUDED.thread_id,
           event_types = EXCLUDED.event_types,
           priority = EXCLUDED.priority,
           status = EXCLUDED.status`,
        [
          route.businessId,
          route.id,
          route.integrationId,
          route.agentId,
          route.channelId,
          route.threadId,
          JSON.stringify(route.eventTypes),
          route.priority,
          route.status,
        ]
      );
    });
  }

  async loadRoutingSnapshot(
    businessId: string,
    provider: string,
    externalTenantId: string
  ): Promise<PersistedRoutingSnapshot> {
    return this.transactions.withTransaction(async (transaction) => {
      const integrations = await transaction.query<IntegrationRow>(
        `SELECT i.id, i.business_id, i.app_id, i.external_tenant_id,
                i.external_account_id, i.credential_ref, i.status
           FROM integrations i
           JOIN integration_apps a
             ON a.business_id = i.business_id AND a.id = i.app_id
          WHERE i.business_id = $1
            AND a.provider = $2
            AND i.external_tenant_id = $3`,
        [businessId, provider, externalTenantId]
      );
      const appIds = [...new Set(integrations.rows.map((row) => row.app_id))];
      const integrationIds = integrations.rows.map((row) => row.id);
      if (integrationIds.length === 0) {
        return { apps: [], integrations: [], accessGrants: [], routes: [] };
      }
      const apps = await transaction.query<AppRow>(
        `SELECT id, business_id, provider, external_app_id, credential_refs, status
           FROM integration_apps
          WHERE business_id = $1 AND id = ANY($2::text[])`,
        [businessId, appIds]
      );
      const grants = await transaction.query<AccessGrantRow>(
        `SELECT id, business_id, integration_id, definition, status
           FROM integration_access_grants
          WHERE business_id = $1 AND integration_id = ANY($2::text[])`,
        [businessId, integrationIds]
      );
      const routes = await transaction.query<RouteRow>(
        `SELECT id, business_id, integration_id, agent_id, channel_id, thread_id,
                event_types, priority, status
           FROM integration_routes
          WHERE business_id = $1 AND integration_id = ANY($2::text[])
          ORDER BY priority DESC, id`,
        [businessId, integrationIds]
      );
      return {
        apps: apps.rows.map(persistedApp),
        integrations: integrations.rows.map(persistedIntegration),
        accessGrants: grants.rows.map(persistedAccessGrant),
        routes: routes.rows.map(persistedRoute),
      };
    });
  }

  /** Active + revoked routes for one Integration, highest priority first — drives route-management UI. */
  async listRoutes(businessId: string, integrationId: string): Promise<PersistedChannelRoute[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const routes = await transaction.query<RouteRow>(
        `SELECT id, business_id, integration_id, agent_id, channel_id, thread_id,
                event_types, priority, status
           FROM integration_routes
          WHERE business_id = $1 AND integration_id = $2
          ORDER BY priority DESC, id`,
        [businessId, integrationId]
      );
      return routes.rows.map(persistedRoute);
    });
  }

  /** Marks one Route revoked without needing its full definition re-supplied. */
  async revokeRoute(businessId: string, id: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE integration_routes SET status = 'revoked' WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
    });
  }

  /** Current status of one Integration/Route pair, for re-checking authorization at delivery time. */
  async loadDeliveryStatus(
    businessId: string,
    integrationId: string,
    routeId: string
  ): Promise<
    | { integrationStatus: IntegrationProjectionStatus; routeStatus: IntegrationProjectionStatus }
    | undefined
  > {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{
        integration_status: IntegrationProjectionStatus;
        route_status: IntegrationProjectionStatus;
      }>(
        `SELECT i.status AS integration_status, r.status AS route_status
           FROM integration_routes r
           JOIN integrations i
             ON i.business_id = r.business_id AND i.id = r.integration_id
          WHERE r.business_id = $1 AND r.integration_id = $2 AND r.id = $3`,
        [businessId, integrationId, routeId]
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return { integrationStatus: row.integration_status, routeStatus: row.route_status };
    });
  }
}
