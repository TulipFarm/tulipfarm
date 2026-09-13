import type { LiveSourceAuthorizationPort, OimKnowledgeSourceLocator } from "@tulipfarm/knowledge";
import type { PersistedConnection, VerifiedConnectionExternalIdentity } from "@tulipfarm/storage";
import type { ExternalIdentityMappingDoc, ExternalIdentityRepo } from "../identity/external-links";
import { isProvenLink } from "../identity/external-links";

export interface OimProviderLiveAuthorizationPort {
  /**
   * Executes only the installed manifest's live-authorization operation for this exact locator.
   * The adapter must reject a missing, changed, or untrusted Integration release.
   */
  check(input: {
    readonly businessId: string;
    readonly locator: OimKnowledgeSourceLocator;
    readonly externalSubject: string;
    readonly connectionIdentity: VerifiedConnectionExternalIdentity;
  }): Promise<{ readonly allowed: boolean; readonly aclRevision?: string } | undefined>;
}

export interface OimLiveSourceAuthorizationDeps {
  readonly connections: {
    findById(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
  };
  readonly connectionIdentities: {
    find(
      businessId: string,
      connectionId: string
    ): Promise<VerifiedConnectionExternalIdentity | null>;
  };
  readonly connectionAccess: {
    canUse(
      principal: Readonly<{ kind: string; id: string }>,
      connection: PersistedConnection
    ): Promise<boolean>;
  };
  readonly identities: Pick<ExternalIdentityRepo, "listProvenMappingsForUser">;
  readonly provider: OimProviderLiveAuthorizationPort;
  readonly now?: () => Date;
}

function matchesSource(
  input: Parameters<LiveSourceAuthorizationPort["check"]>[0],
  locator: OimKnowledgeSourceLocator
): boolean {
  return (
    input.businessId.length > 0 &&
    input.sourceId === `${locator.integrationId}:${locator.connectionId}/${locator.itemId}` &&
    input.provider === locator.integrationId &&
    input.externalId === locator.itemId &&
    input.externalTenantId === locator.externalTenantId
  );
}

function matchesConnection(
  connection: PersistedConnection,
  proof: VerifiedConnectionExternalIdentity,
  businessId: string,
  locator: OimKnowledgeSourceLocator,
  now: Date
): boolean {
  return (
    connection.businessId === businessId &&
    connection.id === locator.connectionId &&
    connection.integration.id === locator.integrationId &&
    connection.integration.majorVersion === locator.integrationMajorVersion &&
    connection.status === "active" &&
    connection.health.status !== "action_required" &&
    (connection.expiresAt === null || new Date(connection.expiresAt) > now) &&
    proof.businessId === businessId &&
    proof.connectionId === locator.connectionId &&
    proof.integrationId === locator.integrationId &&
    proof.integrationMajorVersion === locator.integrationMajorVersion &&
    proof.externalTenantId === locator.externalTenantId &&
    proof.externalAccountId === locator.externalAccountId
  );
}

function mappingMatches(
  mapping: ExternalIdentityMappingDoc,
  userId: string,
  locator: OimKnowledgeSourceLocator,
  now: Date
): boolean {
  return (
    mapping.userId === userId &&
    mapping.provider === locator.integrationId &&
    mapping.externalTenantId === locator.externalTenantId &&
    isProvenLink(mapping) &&
    (mapping.expiresAt === null || mapping.expiresAt > now)
  );
}

export class OimLiveSourceAuthorization implements LiveSourceAuthorizationPort {
  private readonly now: () => Date;

  constructor(private readonly deps: OimLiveSourceAuthorizationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    const locator = input.sourceLocator;
    if (locator?.kind !== "oim" || !matchesSource(input, locator)) return { allowed: false };

    let connection: PersistedConnection | null;
    let proof: VerifiedConnectionExternalIdentity | null;
    try {
      [connection, proof] = await Promise.all([
        this.deps.connections.findById(input.businessId, locator.connectionId),
        this.deps.connectionIdentities.find(input.businessId, locator.connectionId),
      ]);
    } catch {
      return { allowed: false };
    }
    const now = this.now();
    if (
      connection === null ||
      proof === null ||
      !matchesConnection(connection, proof, input.businessId, locator, now)
    ) {
      return { allowed: false };
    }

    for (const principal of input.principals) {
      if (principal.kind !== "user") continue;
      if (connection.owner.scope === "personal" && connection.owner.principalId !== principal.id) {
        continue;
      }
      try {
        if (!(await this.deps.connectionAccess.canUse(principal, connection))) continue;
        const mappings = await this.deps.identities.listProvenMappingsForUser(principal.id);
        for (const mapping of mappings) {
          if (!mappingMatches(mapping, principal.id, locator, now)) continue;
          const decision = await this.deps.provider.check({
            businessId: input.businessId,
            locator,
            externalSubject: mapping.externalSubject,
            connectionIdentity: proof,
          });
          if (decision?.allowed === true) return decision;
        }
      } catch {
        return { allowed: false };
      }
    }
    return { allowed: false };
  }
}

export function createOimLiveSourceAuthorization(
  deps: OimLiveSourceAuthorizationDeps
): LiveSourceAuthorizationPort {
  return new OimLiveSourceAuthorization(deps);
}
