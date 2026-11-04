import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import { GovernanceConflict, type createGovernanceService } from '@tulipfarm/workspaces/governance';
import { redeemInvitationSchema } from '@tulipfarm/workspaces/governance-contracts';

type Governance = ReturnType<typeof createGovernanceService>;
/** Set once workspace storage starts; auth is created before the governance service exists. */
export type InvitationLinks = {
  current: Pick<Governance, 'invitationDetails' | 'redeemInvitationForNewAccount'> | null;
};

function answer(error: unknown): never {
  if (error instanceof APIError) throw error;
  if (error instanceof z.ZodError || error instanceof AccessDenied)
    throw new APIError('NOT_FOUND', { code: 'INVITATION_UNAVAILABLE', message: 'This invitation is not available.' });
  if (error instanceof GovernanceConflict && error.code === 'invitation-account-exists')
    throw new APIError('CONFLICT', { code: 'ACCOUNT_EXISTS', message: 'An account already exists for this address.' });
  if (error instanceof WorkspaceMemberError)
    throw new APIError(error.status === 409 ? 'CONFLICT' : 'SERVICE_UNAVAILABLE', {
      code: error.code.toUpperCase().replaceAll('-', '_'),
      message: 'This invitation cannot be accepted yet.',
    });
  if (error instanceof StorageUnavailableError || error instanceof GovernanceConflict)
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'WORKSPACE_UNAVAILABLE', message: 'Try again shortly.' });
  throw error;
}

function governance(links: InvitationLinks) {
  if (!links.current)
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'WORKSPACE_UNAVAILABLE', message: 'Try again shortly.' });
  return links.current;
}

/**
 * Lets an invitation link stand in for an email sign-in link, but only to create the invited address's account on
 * the invitation's first redemption. It never signs in to an existing account and never replaces a signed-in session.
 */
export function invitationSignIn(links: InvitationLinks, enabled: boolean) {
  return {
    id: 'invitation-sign-in',
    endpoints: {
      invitationDetails: createAuthEndpoint(
        '/invitation/details',
        { method: 'POST', body: redeemInvitationSchema, requireHeaders: true },
        async ctx => {
          const details = await governance(links)
            .invitationDetails(ctx.body.token)
            .catch(error => answer(error));
          return ctx.json(
            details.status === 'active' ? { ...details, linkSignIn: enabled && !details.hasAccount } : details,
          );
        },
      ),
      signInWithInvitation: createAuthEndpoint(
        '/invitation/sign-in',
        { method: 'POST', body: redeemInvitationSchema, requireHeaders: true },
        async ctx => {
          if (!enabled)
            throw new APIError('NOT_FOUND', {
              code: 'INVITATION_SIGN_IN_DISABLED',
              message: 'Invitation links cannot sign in on this instance.',
            });
          if (await getSessionFromCtx(ctx))
            throw new APIError('CONFLICT', { code: 'SIGNED_IN', message: 'Sign out before using this invitation.' });
          const adapter = ctx.context.internalAdapter;
          const joined = await governance(links)
            .redeemInvitationForNewAccount(ctx.body.token, {
              // The invitation reached this address, so it is proven the way an email sign-in link proves it.
              create: async email =>
                (await adapter.createUser({ email, emailVerified: true, name: '' }, { method: 'invitation-link' })).id,
              remove: userId => adapter.deleteUser(userId),
            })
            .catch(error => answer(error));
          const user = await adapter.findUserById(joined.userId);
          const session = user && (await adapter.createSession(user.id));
          if (!user || !session)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              code: 'FAILED_TO_CREATE_SESSION',
              message: 'You joined the workspace. Sign in to open it.',
            });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ workspaceId: joined.workspaceId, membershipId: joined.membershipId });
        },
      ),
    },
    rateLimit: [
      { pathMatcher: path => path === '/invitation/details', window: 60, max: 20 },
      { pathMatcher: path => path === '/invitation/sign-in', window: 60, max: 5 },
    ],
  } satisfies BetterAuthPlugin;
}
