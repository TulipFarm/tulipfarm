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

/**
 * Decides whether a principal may act through a Connection.
 *
 * Personal Connections answer from ownership alone and never reach the RBAC engine: the spec makes
 * them human-owner-only and undelegatable, so a grant that could open one to somebody else must not
 * exist to be misconfigured. Team Connections require live access to their exact owning Team;
 * organization Connections retain their explicit use grant. Both default-deny when their authority
 * layer cannot be read.
 */
export function connectionUseAuthorizer(
  deps: ConnectionUseAuthorizerDeps
): ConnectionUseAuthorizer {
  return {
    async canUse(
      principal: ConnectionPrincipal,
      connection: PersistedConnection
    ): Promise<boolean> {
      if (connection.owner.scope === "personal") {
        return principal.kind === "user" && principal.id === connection.owner.principalId;
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
