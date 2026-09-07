import { type AuthorityLayer, decideEffectivePermission } from "@tulipfarm/authz";
import type { ConnectionPrincipal, ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { AuthorityPrincipal } from "@tulipfarm/tool-host";

/**
 * Runtime permission to *use* a shared Connection.
 *
 * Deliberately not one of the management actions: someone who may create, bind, rotate or revoke a
 * Connection is administering the credential, and someone who may spend it is not. Collapsing the
 * two would make every operator of a Connection an administrator of it, and every administrator a
 * silent user of every credential they can see.
 */
export const CONNECTION_USE_ACTION = "connection.use";
export const CONNECTION_RESOURCE_TYPE = "connection";

export interface ConnectionUseAuthorizerDeps {
  readonly businessId: string;
  resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
  hasTeamMembership(principalId: string, teamId: string): Promise<boolean>;
  isUserActive?(principalId: string): Promise<boolean>;
  isTeamActive?(teamId: string): Promise<boolean>;
}

/**
 * The principal kinds the authority engine can resolve grants for.
 *
 * A `ConnectionPrincipal` carries a free-form kind, and one outside this set has no layer to read.
 * Treating it as unknown-and-denied keeps a new principal kind from reaching organization
 * credentials before anyone has decided what it may hold.
 */
const AUTHORITY_KINDS = new Set<AuthorityPrincipal["kind"]>([
  "agent",
  "api",
  "integration_adapter",
  "routine",
  "service",
  "user",
]);

function authorityKind(kind: string): AuthorityPrincipal["kind"] | undefined {
  return AUTHORITY_KINDS.has(kind as AuthorityPrincipal["kind"])
    ? (kind as AuthorityPrincipal["kind"])
    : undefined;
}

function integrationOwnerHostLayer(
  principal: ConnectionPrincipal,
  connection: PersistedConnection
): AuthorityLayer | undefined {
  if (
    principal.kind !== "integration_adapter" ||
    principal.id !== `integration:${connection.integration.id}`
  ) {
    return undefined;
  }
  return {
    name: `integration-owner:${connection.integration.id}`,
    grants: [
      {
        action: CONNECTION_USE_ACTION,
        resourceType: CONNECTION_RESOURCE_TYPE,
        recordSelector: connection.id,
        effect: "allow",
      },
    ],
  };
}

/**
 * Decides whether a principal may act through a Connection.
 *
 * Personal Connections require the owner's user principal. A delegated Run reaches this gate only
 * after the host intersects its authority with that owner; an Agent id cannot impersonate them.
 * An Integration adapter receives one host-owned grant for its own shared Connections. Other Team
 * callers require live membership, while organization callers require a use grant.
 */
export function connectionUseAuthorizer(
  deps: ConnectionUseAuthorizerDeps
): ConnectionUseAuthorizer {
  return {
    async canUse(
      principal: ConnectionPrincipal,
      connection: PersistedConnection
    ): Promise<boolean> {
      if (connection.businessId !== deps.businessId) return false;
      if (
        principal.kind === "user" &&
        deps.isUserActive !== undefined &&
        !(await deps.isUserActive(principal.id))
      ) {
        return false;
      }
      if (connection.owner.scope === "personal") {
        return principal.kind === "user" && principal.id === connection.owner.principalId;
      }
      const hostLayer = integrationOwnerHostLayer(principal, connection);
      if (
        hostLayer !== undefined &&
        connection.owner.scope === "team" &&
        (deps.isTeamActive === undefined || !(await deps.isTeamActive(connection.owner.teamId)))
      ) {
        return false;
      }
      if (
        hostLayer !== undefined &&
        decideEffectivePermission([hostLayer], {
          action: CONNECTION_USE_ACTION,
          resourceType: CONNECTION_RESOURCE_TYPE,
          recordId: connection.id,
        }).allowed
      ) {
        return true;
      }
      const kind = authorityKind(principal.kind);
      if (kind === undefined) return false;
      if (connection.owner.scope === "team") {
        try {
          return await deps.hasTeamMembership(principal.id, connection.owner.teamId);
        } catch {
          return false;
        }
      }
      let layer: AuthorityLayer;
      try {
        layer = await deps.resolvePrincipalLayer(kind, {
          id: principal.id,
          businessId: deps.businessId,
          kind,
        });
      } catch {
        return false;
      }
      return decideEffectivePermission([layer], {
        action: CONNECTION_USE_ACTION,
        resourceType: CONNECTION_RESOURCE_TYPE,
        recordId: connection.id,
      }).allowed;
    },
  };
}
