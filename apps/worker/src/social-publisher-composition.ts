import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { requireAgentPermission } from '@tulipfarm/agents/saved-service';
import { socialPlatformApps } from '@tulipfarm/extensions';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createBackgroundJob, isFeatureEnabled, log } from '@tulipfarm/observability';
import { createSocialAccounts, type SocialRuntime } from '@tulipfarm/social/accounts';
import type { SocialPlatformAdapter } from '@tulipfarm/social/adapter';
import { createSocialChannels } from '@tulipfarm/social/channels';
import type { Platform } from '@tulipfarm/social/contracts';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPublisher, type MediaUrlSigner } from '@tulipfarm/social/publisher';
import { hasGrant } from '@tulipfarm/workflows/authorization';

export type SocialPublisherOptions = {
  runtime: SocialRuntime;
  /** Ready workspaces after a cursor, one page at a time. */
  discover(after: string | null): Promise<string[]>;
  adapters?: Partial<Record<Platform, SocialPlatformAdapter>>;
  mediaUrl?: MediaUrlSigner;
  /** Whether social publishing is on for a workspace; the worker checks it as the API does. */
  enabled?(workspaceId: string): Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
};

const pageSize = 10;
const refreshIntervalMs = 60_000;

/**
 * The OAuth callback the platform apps are registered with. Production has no local fallback: refreshing against a
 * callback the platforms do not know would fail, or worse, name a host the operator does not control.
 */
function socialCallbackUrl(env: NodeJS.ProcessEnv) {
  const origin = env.BETTER_AUTH_URL ?? (env.NODE_ENV === 'production' ? undefined : 'http://localhost:3001');
  return origin ? new URL('/v1/social/oauth/callback', origin).href : null;
}

/**
 * The publish sweep and the credential refresh sweep (TECH, The step sweep; Accounts and tokens). Both visit only
 * workspaces where the `social-publishing` flag is on. Returns null when the credential keyring is not configured,
 * or in production without BETTER_AUTH_URL.
 */
export function createSocialPublisherComposition(options: SocialPublisherOptions) {
  const env = options.env ?? process.env;
  const adapters = options.adapters ?? {};
  const callbackUrl = socialCallbackUrl(env);
  if (!callbackUrl) {
    log('error', 'lifecycle', 'integration_unconfigured', { provider: 'social', status: 'missing' });
    return null;
  }
  let services;
  try {
    const accounts = createSocialAccounts({
      runtime: options.runtime,
      keyring: integrationCredentialKeyring(env),
      platformApps: createPlatformApps({
        hosted: socialPlatformApps(),
        operator: operatorPlatformApps(env),
        callbackUrl,
      }),
      adapters,
    });
    const channels = createSocialChannels({
      runtime: options.runtime,
      accounts,
      adapters,
      agentPermission: (tx, sponsor, agentId) => requireAgentPermission(tx, sponsor, agentId, 'invoke'),
    });
    const publisher = createSocialPublisher({
      runtime: options.runtime,
      accounts,
      channels,
      adapters,
      requireSources: requireDraftSources,
      workflowGrant: (tx, membershipId, workflowId) => hasGrant(tx, membershipId, workflowId, 'invoke'),
      ...(options.mediaUrl ? { mediaUrl: options.mediaUrl } : {}),
    });
    services = { accounts, publisher };
  } catch {
    return null;
  }
  const { accounts, publisher } = services;
  const enabled =
    options.enabled ??
    ((workspaceId: string) =>
      isFeatureEnabled('social-publishing', { id: 'social-publisher' }, { id: workspaceId }, env));
  const publishJob = createBackgroundJob('social-publisher', 15);
  const refreshJob = createBackgroundJob('social-refresh', 60);
  let running: Promise<void> | undefined;
  let refreshedAt = 0;

  /** Runs `each` for every ready workspace with the flag on; one workspace's failure does not stop the others. */
  async function everyWorkspace(each: (workspaceId: string) => Promise<unknown>, label: string) {
    const failures: unknown[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await options.discover(after);
      for (const workspaceId of page) {
        try {
          if (await enabled(workspaceId)) await each(workspaceId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (page.length < pageSize) break;
      after = page.at(-1)!;
    }
    if (failures.length) throw new AggregateError(failures, `${label} incomplete`);
  }
  const sweep = () => everyWorkspace(workspaceId => publisher.sweep(workspaceId), 'Social publish sweep');
  const refresh = () => everyWorkspace(workspaceId => accounts.refreshDue(workspaceId), 'Social refresh sweep');

  function tick(force = false) {
    if (running) return running;
    const refreshing = force || Date.now() - refreshedAt >= refreshIntervalMs;
    if (refreshing) refreshedAt = Date.now();
    running = (async () => {
      // Each job records its own failure; tokens are refreshed before the steps that use them.
      if (refreshing) await refreshJob.run(refresh).catch(() => undefined);
      await publishJob.run(sweep).catch(() => undefined);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? 15_000);
  timer.unref();
  tick();
  return {
    /** One pass of both sweeps, after any pass already running. */
    async runOnce() {
      await running;
      await tick(true);
    },
    async close() {
      clearInterval(timer);
      await running;
      publishJob.close();
      refreshJob.close();
    },
  };
}
