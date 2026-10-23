import assert from 'node:assert/strict';
import { test } from 'node:test';
import { developmentAdapters } from '../dist/environment.js';
import { capabilitiesFor, tierCapabilities } from '../dist/platform-apps.js';

const app = accessTier => ({ clientId: 'development-client', clientSecret: 'development-secret', accessTier });

test('ROLLOUT rule 7: the development fake grants exactly the scopes each access tier requests', async () => {
  for (const [platform, tiers] of Object.entries(tierCapabilities)) {
    const adapter = developmentAdapters({ NODE_ENV: 'development', SOCIAL_DEVELOPMENT_FAKE_PLATFORM: platform })[
      platform
    ];
    for (const tier of Object.keys(tiers)) {
      const requested = adapter.scopes(tier, capabilitiesFor(platform, tier));
      const exchanged = await adapter.exchangeCode({
        app: app(tier),
        redirectUri: 'http://localhost:3001/v1/social/oauth/callback',
        code: 'development-code',
        codeVerifier: 'v'.repeat(43),
      });
      assert.deepEqual(exchanged.scopes, requested, `${platform} ${tier} exchange`);
      const refreshed = await adapter.refresh(exchanged, app(tier));
      assert.deepEqual(refreshed.scopes, requested, `${platform} ${tier} refresh`);
    }
  }
  // LinkedIn's share tier asks for public posting, which the connection needs before a channel can be added.
  const linkedin = developmentAdapters({
    NODE_ENV: 'development',
    SOCIAL_DEVELOPMENT_FAKE_PLATFORM: 'linkedin',
  }).linkedin;
  const share = await linkedin.exchangeCode({ app: app('share'), redirectUri: 'x', code: 'c', codeVerifier: 'v' });
  assert.deepEqual(share.scopes, ['fake.read', 'fake.publish', 'fake.publish-public']);
});

test('ROLLOUT rule 7: the development fake is never offered in production or when unset', () => {
  assert.deepEqual(developmentAdapters({ NODE_ENV: 'production', SOCIAL_DEVELOPMENT_FAKE_PLATFORM: 'linkedin' }), {});
  assert.deepEqual(developmentAdapters({ NODE_ENV: 'development' }), {});
});
