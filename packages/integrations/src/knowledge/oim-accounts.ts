import { readPointer } from "../egress/oim-pagination";
import type { ProviderAccountPort } from "./oim-identity";
import type { KnowledgeProfilePlan } from "./oim-profile";
import type { OimKnowledgeApiPort, OimKnowledgeExecutionScope } from "./oim-sync";

const MAX_MEMBER_PAGES = 50;

export function createOimProviderAccountPort(
  plan: KnowledgeProfilePlan,
  api: OimKnowledgeApiPort
): ProviderAccountPort {
  const user = plan.identity?.user;
  const group = plan.identity?.group;
  return {
    async account(input) {
      if (user === undefined || !matchesApiConnection(plan, api, input)) return undefined;
      try {
        const { body } = await api.execute({
          operationId: user.operation.id,
          parameters: { [user.idParameter]: input.providerId },
        });
        const providerId = readPointer(body, user.mapping.providerId);
        if (!matchesProviderId(providerId, input.providerId)) return undefined;
        const email =
          user.mapping.email === undefined ? undefined : readPointer(body, user.mapping.email);
        const verified =
          user.mapping.emailVerified === undefined
            ? undefined
            : readPointer(body, user.mapping.emailVerified);
        return {
          ...(typeof email === "string" && email.length > 0 ? { email } : {}),
          ...(verified === undefined ? {} : { emailVerified: verified === true }),
        };
      } catch {
        return undefined;
      }
    },

    async groupMembers(input) {
      if (group?.membersPointer === undefined || !matchesApiConnection(plan, api, input)) {
        return undefined;
      }
      const members: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        let response: Awaited<ReturnType<OimKnowledgeApiPort["execute"]>>;
        try {
          response = await api.execute({
            operationId: group.operation.id,
            parameters: { [group.idParameter]: input.groupId },
            ...(pageToken === undefined ? {} : { pageToken }),
          });
        } catch {
          return undefined;
        }
        const providerId = readPointer(response.body, group.mapping.providerId);
        if (!matchesProviderId(providerId, input.groupId)) return undefined;
        const raw = readPointer(response.body, group.membersPointer);
        if (!Array.isArray(raw)) return undefined;
        for (const entry of raw) {
          const id =
            group.mapping.memberUserId === undefined
              ? entry
              : readPointer(entry, group.mapping.memberUserId);
          if (typeof id === "string" && id.length > 0) members.push(id);
          else if (typeof id === "number" && Number.isFinite(id)) members.push(String(id));
          else return undefined;
        }
        if (response.nextPageToken === undefined) return members;
        pageToken = response.nextPageToken;
      }
      return undefined;
    },
  };
}

function matchesProviderId(value: unknown, expected: string): boolean {
  return (
    (typeof value === "string" && value === expected) ||
    (typeof value === "number" && Number.isFinite(value) && String(value) === expected)
  );
}

function matchesApiConnection(
  plan: KnowledgeProfilePlan,
  api: OimKnowledgeApiPort,
  input: OimKnowledgeExecutionScope
): boolean {
  return (
    api.connection.businessId === input.businessId &&
    api.connection.integrationId === plan.integrationId &&
    api.connection.integrationId === input.integrationId &&
    api.connection.integrationMajorVersion === plan.majorVersion &&
    api.connection.integrationMajorVersion === input.integrationMajorVersion &&
    api.connection.connectionId === input.connectionId &&
    api.connection.externalTenantId === input.externalTenantId &&
    api.connection.externalAccountId === input.externalAccountId
  );
}
