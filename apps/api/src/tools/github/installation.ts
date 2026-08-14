import type { GitHubPermissionLevel } from "@tulipfarm/integrations";
import type { IntegrationStore } from "@tulipfarm/storage";

/** Local projection of active GitHub installations for credential minting and scope checks. */
export interface GitHubInstallationRecord {
  readonly integrationId: string;
  readonly installationId: string;
  readonly accountLogin: string;
  /** GitHub App id (the JWT `iss`), from the App row Phase 2 writes alongside the installation. */
  readonly appExternalId: string;
  readonly repositories: readonly string[];
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
}

export interface GitHubInstallationDirectory {
  list(): Promise<readonly GitHubInstallationRecord[]>;
}

function readPermissions(raw: unknown): Record<string, GitHubPermissionLevel> {
  const permissions: Record<string, GitHubPermissionLevel> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return permissions;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "read" || value === "write") permissions[key] = value;
  }
  return permissions;
}

function readRepositories(raw: unknown): string[] {
  const externalTargets = (raw as { externalTargets?: { ids?: unknown } } | undefined)
    ?.externalTargets;
  const ids = externalTargets?.ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

export interface StoreGitHubInstallationDirectoryOptions {
  readonly now?: () => Date;
  /** How long a listing is trusted before the next call re-reads the store. */
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

interface CachedListing {
  readonly records: readonly GitHubInstallationRecord[];
  readonly expiresAt: number;
}

/** Short-TTL store read shared by scope and credential resolution. */
export class StoreGitHubInstallationDirectory implements GitHubInstallationDirectory {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private cached: CachedListing | undefined;

  constructor(
    private readonly integrations: IntegrationStore,
    private readonly businessId: string,
    options: StoreGitHubInstallationDirectoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async list(): Promise<readonly GitHubInstallationRecord[]> {
    if (this.cached !== undefined && this.cached.expiresAt > this.now().getTime()) {
      return this.cached.records;
    }

    const records = await this.load();
    this.cached = { records, expiresAt: this.now().getTime() + this.ttlMs };
    return records;
  }

  private async load(): Promise<readonly GitHubInstallationRecord[]> {
    const snapshot = await this.integrations.loadProviderSnapshot(this.businessId, "github");
    const appsById = new Map(snapshot.apps.map((app) => [app.id, app]));
    const grantsByIntegrationId = new Map(
      snapshot.accessGrants.map((grant) => [grant.integrationId, grant])
    );

    const records: GitHubInstallationRecord[] = [];
    for (const integration of snapshot.integrations) {
      if (integration.status !== "active") continue;
      const app = appsById.get(integration.appId);
      if (app === undefined || app.status !== "active") continue;
      const grant = grantsByIntegrationId.get(integration.id);
      if (grant === undefined || grant.status !== "active") continue;

      records.push({
        integrationId: integration.id,
        installationId: integration.externalTenantId,
        accountLogin: integration.externalAccountId ?? integration.externalTenantId,
        appExternalId: app.externalAppId,
        repositories: readRepositories(grant.definition),
        permissions: readPermissions(
          (grant.definition as { permissions?: unknown } | undefined)?.permissions
        ),
      });
    }
    return records;
  }
}
