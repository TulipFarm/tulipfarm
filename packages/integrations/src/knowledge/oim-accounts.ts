/**
 * The provider half of identity resolution, built from a manifest's declared identity operations.
 *
 * `resolveKnowledgePrincipals` needs two provider facts it cannot get from an ACL entry alone: the
 * email a provider account holds and whether the provider considers it verified, and the members of
 * a group grant. Both come from operations the Knowledge profile already named, so this adapter
 * exists to call them rather than to invent a second source of truth about who someone is.
 *
 * Every failure here answers `undefined`. An account that cannot be read contributes no email, and
 * an unreadable group makes the ACL incomplete — which the sync turns into an unverifiable source.
 * Guessing either way would widen access on a provider error.
 */

import { readPointer } from "../egress/oim-pagination";
import { isOimKnowledgeRetryRequiredError } from "./oim-errors";
import type { ProviderAccountPort } from "./oim-mapping";
import type { KnowledgeProfilePlan } from "./oim-profile";
import type { OimKnowledgeApiPort } from "./oim-sync";

/** Reads a group's membership one page at a time; a provider need not return it all at once. */
const MAX_MEMBER_PAGES = 50;

export function createOimProviderAccountPort(
  plan: KnowledgeProfilePlan,
  api: OimKnowledgeApiPort
): ProviderAccountPort {
  const user = plan.identity?.user;
  const group = plan.identity?.group;

  return {
    async account({ providerId }) {
      if (user === undefined) return undefined;
      let body: unknown;
      try {
        ({ body } = await api.execute({
          operationId: user.operation.id,
          parameters: { [user.idParameter]: providerId },
        }));
      } catch (error) {
        if (isOimKnowledgeRetryRequiredError(error)) throw error;
        return undefined;
      }
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
    },

    async groupMembers({ groupId }) {
      if (group === undefined || group.membersPointer === undefined) return undefined;
      const members: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        let body: unknown;
        let nextPageToken: string | undefined;
        try {
          ({ body, nextPageToken } = await api.execute({
            operationId: group.operation.id,
            parameters: { [group.idParameter]: groupId },
            ...(pageToken === undefined ? {} : { pageToken }),
          }));
        } catch (error) {
          if (isOimKnowledgeRetryRequiredError(error)) throw error;
          // A page that fails mid-walk leaves a membership that is only partly known, which is
          // exactly the case `undefined` exists for: a partial list would silently drop members.
          return undefined;
        }
        const raw = readPointer(body, group.membersPointer);
        if (!Array.isArray(raw)) return undefined;
        for (const entry of raw) {
          const id =
            group.mapping.memberUserId === undefined
              ? entry
              : readPointer(entry, group.mapping.memberUserId);
          if (typeof id === "string" && id.length > 0) members.push(id);
          else if (typeof id === "number") members.push(String(id));
        }
        if (nextPageToken === undefined) return members;
        pageToken = nextPageToken;
      }
      // Hitting the page bound means the membership is longer than this adapter will read, so it
      // is unknown rather than complete.
      return undefined;
    },
  };
}
