import type { McpAccountAuthorization } from "@tulipfarm/integrations";
import type { TeamRepo } from "@tulipfarm/storage";
import type { UserRepo } from "../../auth/users";
import type { AuthorizationCheck } from "../../authz/route-gate";
import { userPrincipal } from "../../identity/principal";

export function createMcpAccountAuthorization(deps: {
  readonly businessId: string;
  readonly users: Pick<UserRepo, "findById">;
  readonly teams: Pick<TeamRepo, "getTeam" | "getMembership">;
  readonly authorizationCheck: AuthorizationCheck;
  readonly now?: () => Date;
}): McpAccountAuthorization {
  const activeUser = async (businessId: string, principalId: string) => {
    if (businessId !== deps.businessId) return undefined;
    const user = await deps.users.findById(principalId);
    return user?._id === principalId && user.status === "active" ? user : undefined;
  };
  return {
    async isActivePrincipal(businessId, principalId) {
      return (await activeUser(businessId, principalId)) !== undefined;
    },
    async isTeamMember(businessId, teamId, principalId) {
      if (!(await activeUser(businessId, principalId))) return false;
      const team = await deps.teams.getTeam(businessId, teamId);
      if (team?.status !== "active") return false;
      const membership = await deps.teams.getMembership(teamId, principalId);
      return (
        membership?.principalKind === "user" &&
        membership.principalId === principalId &&
        membership.teamId === teamId &&
        (membership.expiresAt === undefined ||
          membership.expiresAt.getTime() > (deps.now?.() ?? new Date()).getTime())
      );
    },
    async canManageShared(businessId, principalId) {
      const user = await activeUser(businessId, principalId);
      if (!user) return false;
      return deps.authorizationCheck(userPrincipal(user, "api_token"), {
        action: "integration.accounts.manage",
        resourceType: "integration_account",
        fallback: "admin",
      });
    },
  };
}
