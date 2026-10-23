import { randomUUID } from 'node:crypto';
import type { PlatformAppCredentials, SocialPlatformAdapter } from './adapter.ts';
import { channelKindsByPlatform, platformSchema, type Platform } from './contracts.ts';
import { signMediaToken } from './media.ts';
import { capabilitiesFor } from './platform-apps.ts';
import { createFakeAdapter } from './platforms/fake.ts';
import type { MediaUrlSigner } from './publisher.ts';

/** The key that signs media URLs, shared by the API and the worker; null when unset or too short. */
export function mediaUrlKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.SOCIAL_MEDIA_URL_KEY;
  return key && Buffer.byteLength(key, 'utf8') >= 32 ? key : null;
}

/** The path the API serves media URLs on. */
export const mediaUrlPath = '/v1/social/media/';

/**
 * Signs the media URLs pull-URL platforms fetch (TECH, Media). Without a key, or in production without a public
 * origin, there is no signer, so media steps on those platforms block as `media-unreadable`.
 */
export function mediaUrlSigner(env: NodeJS.ProcessEnv = process.env): MediaUrlSigner | undefined {
  const key = mediaUrlKey(env);
  const origin =
    env.SOCIAL_MEDIA_PUBLIC_BASE_URL ??
    env.BETTER_AUTH_URL ??
    (env.NODE_ENV === 'production' ? undefined : 'http://localhost:3001');
  if (!key || !origin) return undefined;
  const base = new URL(origin);
  return async grant => new URL(`${mediaUrlPath}${signMediaToken(key, grant)}`, base);
}

/**
 * Development and end-to-end tests only: one platform served by an in-memory fake that connects one channel and
 * publishes every changing step (ROLLOUT, rule 7). Never offered in production. Like a consenting person on the
 * real platform, the fake grants exactly the scopes the configured app's access tier requests.
 */
export function developmentAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<Platform, SocialPlatformAdapter>> {
  if (env.NODE_ENV === 'production' || !env.SOCIAL_DEVELOPMENT_FAKE_PLATFORM) return {};
  const platform = platformSchema.parse(env.SOCIAL_DEVELOPMENT_FAKE_PLATFORM);
  const fake = createFakeAdapter({ platform })
    .fallback('identity', { platformUserId: 'development-person', handle: 'development', displayName: 'Development' })
    .fallback('revoke', 'revoked')
    .fallback('listChannels', [
      {
        platformChannelId: 'development-channel',
        channelKind: channelKindsByPlatform[platform][0],
        displayName: 'Development channel',
        handle: 'development',
        avatarUrl: null,
      },
    ])
    .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
    .fallback('reviewChoices', [])
    .fallback('status', { kind: 'ready' })
    .fallback('reconcile', { kind: 'unknown' });
  const granted = (app: Pick<PlatformAppCredentials, 'accessTier'>) =>
    fake.scopes(app.accessTier, capabilitiesFor(platform, app.accessTier));
  return {
    [platform]: {
      ...fake,
      async exchangeCode(input) {
        return {
          accessToken: 'development-access',
          refreshToken: 'development-refresh',
          expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000),
          scopes: granted(input.app),
        };
      },
      async refresh(_token, app) {
        return {
          accessToken: 'development-access',
          refreshToken: 'development-refresh',
          expiresAt: null,
          scopes: granted(app),
        };
      },
      async mutate() {
        const id = `development-${randomUUID()}`;
        return { kind: 'published', platformPostId: id, permalink: `https://${fake.hosts[0]}/posts/${id}` };
      },
    } satisfies SocialPlatformAdapter,
  };
}
