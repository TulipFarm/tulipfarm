import { AccessDenied } from '@tulipfarm/access';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { requireAgentPermission } from '@tulipfarm/agents/saved-service';
import type { SocialTools } from '@tulipfarm/agents/social-tools';
import { socialPlatformApps } from '@tulipfarm/extensions';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { createSocialAccounts, type SocialRuntime } from '@tulipfarm/social/accounts';
import { createSocialChannels } from '@tulipfarm/social/channels';
import { developmentAdapters } from '@tulipfarm/social/environment';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { SocialError } from '@tulipfarm/social/credentials';
import { createSocialPosts } from '@tulipfarm/social/posts';

/** Whether a member's chat offers the social tools: `social-publishing` is on for them in the workspace. */
export function socialChatEnabled(userId: string, workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  return isFeatureEnabled('social-publishing', { id: userId }, { id: workspaceId }, env);
}

/**
 * The services behind the chat's social tools: prepare, read and revise posts, and list channels, all with the
 * principal's own grants (PRODUCT 36). Deciding needs the confirmation role, which chat never has; a person decides
 * on the review card through the API. Undefined when the credential keyring is not configured.
 */
export function socialChatTools(runtime: SocialRuntime, env: NodeJS.ProcessEnv = process.env): SocialTools | undefined {
  const origin = env.BETTER_AUTH_URL ?? (env.NODE_ENV === 'production' ? undefined : 'http://localhost:3001');
  if (!origin) return undefined;
  try {
    const adapters = developmentAdapters(env);
    const accounts = createSocialAccounts({
      runtime,
      keyring: integrationCredentialKeyring(env),
      platformApps: createPlatformApps({
        hosted: socialPlatformApps(),
        operator: operatorPlatformApps(env),
        callbackUrl: new URL('/v1/social/oauth/callback', origin).href,
      }),
      adapters,
    });
    const channels = createSocialChannels({
      runtime,
      accounts,
      adapters,
      agentPermission: (tx, sponsor, agentId) => requireAgentPermission(tx, sponsor, agentId, 'invoke'),
    });
    const posts = createSocialPosts({
      runtime,
      accounts,
      channels,
      adapters,
      requireSources: requireDraftSources,
      resolveConfirmationCredential: () => Promise.reject(new AccessDenied()),
    });
    return {
      async listChannels(workspaceId, principal, filter) {
        if (principal.kind !== 'agent') return channels.list(workspaceId, principal.userId, filter);
        // An agent sees the sponsor's channels it may publish to; it holds no grants of its own (PRODUCT 11).
        const visible = [];
        for (const channel of await channels.list(workspaceId, principal.sponsor.userId, filter)) {
          try {
            await channels.authorize(workspaceId, principal, channel.id, 'publish');
            visible.push(channel);
          } catch (error) {
            if (!(error instanceof AccessDenied) && !(error instanceof SocialError)) throw error;
          }
        }
        return visible;
      },
      prepare: (workspaceId, principal, input, sources) => posts.prepare(workspaceId, principal, input, sources),
      get: (workspaceId, principal, postId) => posts.get(workspaceId, principal, postId),
      revise: (workspaceId, principal, postId, input, sources) =>
        posts.revise(workspaceId, principal, postId, input, sources),
    };
  } catch {
    return undefined;
  }
}
