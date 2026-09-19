import { type McpIntegrationService, McpSetupService } from "@tulipfarm/integrations";
import { MCP_CATALOG } from "@tulipfarm/mcp";
import type { CommitActor } from "@tulipfarm/soul";
import { McpSetupStore, type Queryable } from "@tulipfarm/storage";
import type { AuditService } from "../../audit/service";
import type { UserRepo } from "../../auth/users";
import type { AuthorizationCheck } from "../../authz/route-gate";
import { userPrincipal } from "../../identity/principal";
import type { composeMcpAccounts } from "./compose";

export function composeMcpSetup(deps: {
  db: Queryable;
  businessId: string;
  service: McpIntegrationService<CommitActor>;
  accounts: ReturnType<typeof composeMcpAccounts>;
  audit: AuditService;
  users: Pick<UserRepo, "findById">;
  authorizationCheck: AuthorizationCheck;
  log: { error: (metadata: Record<string, string>, message: string) => void };
}) {
  return new McpSetupService({
    operations: new McpSetupStore(deps.db),
    integrations: deps.service,
    accounts: deps.accounts.accounts,
    lifecycle: deps.accounts.lifecycle,
    catalog: MCP_CATALOG,
    onUnexpectedFailure: (failure) =>
      deps.log.error({ event: "integration.setup.failed", ...failure }, "MCP setup failed"),
    isActive: (businessId, principalId) =>
      deps.accounts.authorization.isActivePrincipal(businessId, principalId),
    canConfigure: async (businessId, principalId) => {
      if (businessId !== deps.businessId) return false;
      const user = await deps.users.findById(principalId);
      return (
        !!user &&
        user.status === "active" &&
        deps.authorizationCheck(userPrincipal(user, "api_token"), {
          action: "integration.connect",
          resourceType: "integration",
          fallback: "admin",
        })
      );
    },
    audit: async (operation, action) => {
      await deps.audit.record({
        actorId: operation.principalId,
        action,
        target: `integration:${operation.integrationKey}`,
        safeMetadata: {
          setupId: operation.id,
          accountId: operation.accountId ?? null,
          initializePolicy: operation.initializePolicy,
          legacyEmptyPolicyConsent: operation.legacyEmptyPolicyConsent ?? null,
          confirmShared: operation.confirmShared,
        },
      });
    },
  });
}
