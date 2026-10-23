import { Pool } from 'pg';
import { z } from 'zod';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { requireAgentPermission } from '@tulipfarm/agents/saved-service';
import { socialPlatformApps } from '@tulipfarm/extensions';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSocialAccounts, type SocialAccounts, type SocialRuntime } from '@tulipfarm/social/accounts';
import { createSocialChannels, type SocialChannels } from '@tulipfarm/social/channels';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPosts } from '@tulipfarm/social/posts';
import { createConfirmationCredentialResolver } from '@tulipfarm/workspaces/capabilities';
import { authConfig } from './auth.ts';

/**
 * Social connections. Hosted TulipFarm supplies its apps through the `socialPlatformApps` extension slot;
 * otherwise the operator's `SOCIAL_<PLATFORM>_*` settings do. No platform adapter ships yet, so every
 * platform reports `not-configured` until one does.
 */
export function socialAccounts(runtime: SocialRuntime | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!runtime) return null;
  try {
    return createSocialAccounts({
      runtime,
      keyring: integrationCredentialKeyring(env),
      platformApps: createPlatformApps({
        hosted: socialPlatformApps(),
        operator: operatorPlatformApps(env),
        callbackUrl: new URL('/v1/social/oauth/callback', authConfig().baseURL).href,
      }),
      adapters: {},
    });
  } catch {
    return null;
  }
}

/**
 * Channels reached through the same connections and adapters as `socialAccounts`. An agent acts only within
 * the agents domain's permission check for its sponsor, injected here so `@tulipfarm/social` need not depend
 * on `@tulipfarm/agents`.
 */
export function socialChannels(accounts: SocialAccounts | null, runtime: SocialRuntime | undefined) {
  if (!accounts || !runtime) return null;
  return createSocialChannels({
    runtime,
    accounts,
    adapters: {},
    agentPermission: (tx, sponsor, agentId) => requireAgentPermission(tx, sponsor, agentId, 'invoke'),
  });
}

/**
 * Social posts. Decisions are written through the workspace's confirmation login, as other approvals are, so
 * posts are unavailable without the confirmation registry.
 */
export function socialPosts(
  accounts: SocialAccounts | null,
  channels: SocialChannels | null,
  runtime: SocialRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!accounts || !channels || !runtime) return null;
  let pool: Pool;
  try {
    const connectionString = z.url().parse(env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL);
    if (
      decodeURIComponent(new URL(connectionString).username) ===
      decodeURIComponent(new URL(z.url().parse(env.DATABASE_URL)).username)
    )
      return null;
    pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      options: '-c search_path=pg_catalog',
    });
  } catch {
    return null;
  }
  pool.on('error', () => undefined);
  const resolve = createConfirmationCredentialResolver(pool);
  return {
    posts: createSocialPosts({
      runtime,
      accounts,
      channels,
      adapters: {},
      requireSources: requireDraftSources,
      resolveConfirmationCredential: async workspaceId => (await resolve(workspaceId)).connectionString,
    }),
    close: () => pool.end(),
  };
}
