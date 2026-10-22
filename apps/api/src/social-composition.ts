import { socialPlatformApps } from '@tulipfarm/extensions';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSocialAccounts, type SocialAccounts, type SocialRuntime } from '@tulipfarm/social/accounts';
import { createSocialChannels } from '@tulipfarm/social/channels';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
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

/** Channels reached through the same connections and adapters as `socialAccounts`. */
export function socialChannels(accounts: SocialAccounts | null, runtime: SocialRuntime | undefined) {
  if (!accounts || !runtime) return null;
  return createSocialChannels({ runtime, accounts, adapters: {} });
}
