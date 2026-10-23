import { Pool } from 'pg';
import { z } from 'zod';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { requireAgentPermission } from '@tulipfarm/agents/saved-service';
import { socialPlatformApps } from '@tulipfarm/extensions';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSocialAccounts, type SocialAccounts, type SocialRuntime } from '@tulipfarm/social/accounts';
import { createSocialChannels, type SocialChannels } from '@tulipfarm/social/channels';
import { developmentAdapters } from '@tulipfarm/social/environment';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPosts } from '@tulipfarm/social/posts';
import { createSocialPublisher } from '@tulipfarm/social/publisher';
import { hasGrant } from '@tulipfarm/workflows/authorization';
import { createConfirmationCredentialResolver } from '@tulipfarm/workspaces/capabilities';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { authConfig } from './auth.ts';
import { filesObjectAdapter } from './files-composition.ts';
import type { SocialMediaBytes } from './social-accounts.ts';

const adapterSets = new WeakMap<NodeJS.ProcessEnv, ReturnType<typeof developmentAdapters>>();
/**
 * The platform adapters. No real adapter ships yet; outside production, `SOCIAL_DEVELOPMENT_FAKE_PLATFORM` names
 * one platform served by the fake, for development and end-to-end tests. One set is shared per environment.
 */
function adapters(env: NodeJS.ProcessEnv) {
  let set = adapterSets.get(env);
  if (!set) adapterSets.set(env, (set = developmentAdapters(env)));
  return set;
}

/**
 * Social connections. Hosted TulipFarm supplies its apps through the `socialPlatformApps` extension slot;
 * otherwise the operator's `SOCIAL_<PLATFORM>_*` settings do. A platform without an adapter reports
 * `not-configured`.
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
      adapters: adapters(env),
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
export function socialChannels(
  accounts: SocialAccounts | null,
  runtime: SocialRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!accounts || !runtime) return null;
  return createSocialChannels({
    runtime,
    accounts,
    adapters: adapters(env),
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
      adapters: adapters(env),
      requireSources: requireDraftSources,
      resolveConfirmationCredential: async workspaceId => (await resolve(workspaceId)).connectionString,
    }),
    close: () => pool.end(),
  };
}

/**
 * The publisher's person-facing commands: resume, cancel, candidates and settlement (PRODUCT 24, 25, 39), and the
 * media objects that signed media URLs serve. The sweep itself runs in the worker.
 */
export function socialPublisher(
  accounts: SocialAccounts | null,
  channels: SocialChannels | null,
  runtime: SocialRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!accounts || !channels || !runtime) return null;
  return createSocialPublisher({
    runtime,
    accounts,
    channels,
    adapters: adapters(env),
    requireSources: requireDraftSources,
    workflowGrant: (tx, membershipId, workflowId) => hasGrant(tx, membershipId, workflowId, 'invoke'),
  });
}

/** The files object store, read-only, for the public media route; null when object storage is not configured. */
export function socialMediaBytes(
  env: NodeJS.ProcessEnv = process.env,
): { read: SocialMediaBytes; close(): void } | null {
  const objects = chatObjectStore(env);
  if (!objects) return null;
  const files = filesObjectAdapter(objects);
  return { read: (key, maximumBytes, signal) => files.read(key, maximumBytes, signal), close: () => objects.close() };
}
