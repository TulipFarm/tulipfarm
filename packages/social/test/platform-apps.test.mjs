import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { platforms } from '../dist/contracts.js';
import { SocialError, socialCredentialCipher } from '../dist/credentials.js';
import {
  appFingerprint,
  capabilitiesFor,
  createPlatformApps,
  operatorPlatformApps,
  operatorPrefixes,
  platformAvailability,
} from '../dist/platform-apps.js';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const workspaceId = randomUUID();
const operatorEnv = (platform, tier, overrides = {}) => {
  const prefix = operatorPrefixes[platform];
  return {
    [`${prefix}_CLIENT_ID`]: `${platform}-client`,
    [`${prefix}_CLIENT_SECRET`]: `${platform}-secret`,
    [`${prefix}_REDIRECT_URI`]: callbackUrl,
    [`${prefix}_ACCESS_TIER`]: tier,
    ...overrides,
  };
};
const everyOperatorApp = {
  ...operatorEnv('linkedin', 'share'),
  ...operatorEnv('youtube', 'verified'),
  ...operatorEnv('facebook', 'standard'),
  ...operatorEnv('instagram', 'standard'),
  ...operatorEnv('threads', 'standard'),
  ...operatorEnv('pinterest', 'standard'),
  ...operatorEnv('tiktok', 'audited'),
  ...operatorEnv('x', 'paid'),
  ...operatorEnv('reddit', 'paid'),
};
const hostedApp = (platform, accessTier, generation = 1) => ({
  kind: 'app',
  app: { clientId: `hosted-${platform}`, clientSecret: 'hosted-secret', accessTier, generation },
});
const hostedTiers = {
  linkedin: 'community-management',
  youtube: 'verified',
  facebook: 'advanced',
  instagram: 'advanced',
  threads: 'standard',
  pinterest: 'standard',
  tiktok: 'audited',
  x: 'paid',
  reddit: 'paid',
};
const everyHostedApp = { resolve: async platform => hostedApp(platform, hostedTiers[platform]) };

test('PRODUCT 1: a platform without a shipped adapter is not offered, whatever app is configured', () => {
  const resolution = { kind: 'app', app: { source: 'operator', accessTier: 'share' } };
  assert.deepEqual(platformAvailability('linkedin', resolution, { accessTier: 'share' }, false), {
    platform: 'linkedin',
    available: false,
    reason: 'not-configured',
    appSource: null,
    accessTier: null,
    capabilities: [],
  });
  assert.equal(platformAvailability('linkedin', resolution, null, true).available, true);
});

test('PRODUCT 2: an app offers only the actions its access tier is approved for', () => {
  assert.deepEqual(capabilitiesFor('tiktok', 'unaudited'), ['publish']);
  assert.ok(capabilitiesFor('tiktok', 'audited').includes('publish-public'));
  assert.ok(!capabilitiesFor('pinterest', 'trial').includes('publish-public'));
  assert.ok(!capabilitiesFor('youtube', 'unverified').includes('publish-public'));
  assert.ok(!capabilitiesFor('linkedin', 'share').includes('comments'));
  assert.deepEqual(capabilitiesFor('tiktok', 'paid'), [], 'a tier from another platform grants nothing');
  for (const platform of platforms) assert.ok(capabilitiesFor(platform, hostedTiers[platform]).includes('publish'));
  const unaudited = platformAvailability(
    'tiktok',
    { kind: 'app', app: { source: 'operator', accessTier: 'unaudited' } },
    null,
    true,
  );
  assert.deepEqual(unaudited.capabilities, ['publish']);
});

test('PRODUCT 3: hosted TulipFarm offers its own app first and a workspace app otherwise', async () => {
  const apps = createPlatformApps({ hosted: everyHostedApp, operator: {}, callbackUrl });
  assert.equal(apps.hosted, true);
  const linkedin = await apps.resolveDefault('linkedin', workspaceId);
  assert.equal(linkedin.kind, 'app');
  assert.equal(linkedin.app.source, 'hosted');
  assert.equal(linkedin.app.redirectUri, callbackUrl);
  assert.equal(linkedin.app.platformAppId, null);
  assert.match(linkedin.app.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(platformAvailability('linkedin', linkedin, { accessTier: 'share' }, true).appSource, 'hosted');

  const resolver = { resolve: async () => ({ kind: 'unavailable' }) };
  const none = await createPlatformApps({ hosted: resolver, operator: {}, callbackUrl }).resolveDefault(
    'linkedin',
    workspaceId,
  );
  assert.deepEqual(platformAvailability('linkedin', none, null, true).reason, 'not-configured');
  assert.equal(platformAvailability('linkedin', none, { accessTier: 'share' }, true).appSource, 'workspace');

  const own = apps.workspace({
    id: randomUUID(),
    platform: 'linkedin',
    generation: 2,
    clientId: 'own',
    clientSecret: 's',
    accessTier: 'share',
  });
  assert.equal(own.source, 'workspace');
  assert.equal(own.redirectUri, callbackUrl);
  assert.equal(own.fingerprint, null);
});

test('PRODUCT 3: a hosted resolver that fails or answers out of contract leaves the platform unavailable', async () => {
  for (const resolve of [
    async () => {
      throw new Error('down');
    },
    async () => ({ kind: 'app', app: { clientId: 'c' } }),
    async () => hostedApp('linkedin', 'paid'),
  ]) {
    const apps = createPlatformApps({ hosted: { resolve }, operator: {}, callbackUrl });
    assert.deepEqual(await apps.resolveDefault('linkedin', workspaceId), { kind: 'unavailable' });
  }
});

test('PRODUCT 4: hosted X and Reddit need a workspace app even when operator settings exist', async () => {
  const asked = [];
  const hosted = {
    resolve: async (platform, context) => {
      asked.push([platform, context]);
      return hostedApp(platform, hostedTiers[platform]);
    },
  };
  const apps = createPlatformApps({ hosted, operator: operatorPlatformApps(everyOperatorApp), callbackUrl });
  for (const platform of ['x', 'reddit']) {
    const resolution = await apps.resolveDefault(platform, workspaceId);
    assert.deepEqual(resolution, { kind: 'workspace-app-required' });
    assert.deepEqual(platformAvailability(platform, resolution, null, true), {
      platform,
      available: false,
      reason: 'workspace-app-required',
      appSource: null,
      accessTier: null,
      capabilities: [],
    });
    assert.equal(platformAvailability(platform, resolution, { accessTier: 'paid' }, true).appSource, 'workspace');
  }
  assert.deepEqual(asked, [], 'the hosted resolver is not asked for X or Reddit');
  const linkedin = await apps.resolveDefault('linkedin', workspaceId);
  assert.equal(linkedin.app.source, 'hosted', 'operator settings are never used on hosted TulipFarm');
  assert.deepEqual(asked, [['linkedin', { workspaceId }]]);
});

test('PRODUCT 5: the open-source edition offers only platforms the operator configured completely', async () => {
  assert.deepEqual(Object.keys(operatorPlatformApps(everyOperatorApp)).sort(), [...platforms].sort());
  const partial = {
    ...operatorEnv('linkedin', 'share'),
    ...operatorEnv('youtube', 'verified', { SOCIAL_YOUTUBE_CLIENT_SECRET: '' }),
    ...operatorEnv('tiktok', 'paid'),
    ...operatorEnv('x', 'paid', { SOCIAL_X_REDIRECT_URI: 'not a url' }),
    SOCIAL_REDDIT_CLIENT_ID: 'only-an-id',
  };
  const operator = operatorPlatformApps(partial);
  assert.deepEqual(Object.keys(operator), ['linkedin']);
  assert.deepEqual(operator.linkedin, {
    clientId: 'linkedin-client',
    clientSecret: 'linkedin-secret',
    redirectUri: callbackUrl,
    accessTier: 'share',
  });
  const apps = createPlatformApps({ hosted: undefined, operator, callbackUrl });
  assert.equal(apps.hosted, false);
  const x = await apps.resolveDefault('x', workspaceId);
  assert.deepEqual(x, { kind: 'unavailable' });
  assert.equal(platformAvailability('x', x, null, true).reason, 'not-configured');
  const linkedin = await apps.resolveDefault('linkedin', workspaceId);
  assert.equal(linkedin.app.source, 'operator');
  assert.equal(linkedin.app.generation, null);
  assert.equal(linkedin.app.redirectUri, callbackUrl);
});

test('PRODUCT 6: replacing a hosted or operator app changes the fingerprint a connection records', () => {
  const operator = {
    source: 'operator',
    generation: null,
    clientId: 'c',
    clientSecret: 's',
    redirectUri: callbackUrl,
    accessTier: 'share',
  };
  const base = appFingerprint('linkedin', operator);
  assert.equal(appFingerprint('linkedin', { ...operator }), base);
  for (const change of [
    { clientSecret: 's2' },
    { clientId: 'c2' },
    { redirectUri: `${callbackUrl}/2` },
    { accessTier: 'community-management' },
  ])
    assert.notEqual(appFingerprint('linkedin', { ...operator, ...change }), base, JSON.stringify(change));
  assert.notEqual(appFingerprint('youtube', operator), base);

  const hosted = { ...operator, source: 'hosted', generation: 1 };
  const hostedBase = appFingerprint('linkedin', hosted);
  assert.notEqual(appFingerprint('linkedin', { ...hosted, generation: 2 }), hostedBase);
  assert.equal(
    appFingerprint('linkedin', { ...hosted, clientSecret: 'rotated-with-the-same-generation' }),
    hostedBase,
    'a hosted app is replaced by raising its generation',
  );
});

test('credential envelopes are bound to their purpose, account, generation and credential version', () => {
  const cipher = socialCredentialCipher({ activeKeyId: 'k1', keys: { k1: 'ab'.repeat(32) } });
  const binding = {
    purpose: 'tokens',
    workspaceId,
    accountId: randomUUID(),
    platform: 'linkedin',
    generation: 3,
    credentialVersion: 5,
  };
  const sealed = cipher.encrypt(binding, 'token-value');
  assert.deepEqual(Object.keys(sealed).sort(), ['ciphertext', 'keyId', 'nonce', 'tag']);
  assert.ok(!JSON.stringify(sealed).includes('token-value'));
  assert.equal(cipher.decrypt({ ...binding }, sealed), 'token-value');
  const reordered = Object.fromEntries(Object.entries(binding).reverse());
  assert.equal(cipher.decrypt(reordered, sealed), 'token-value');
  for (const change of [
    { generation: 4 },
    { credentialVersion: 6 },
    { accountId: randomUUID() },
    { workspaceId: randomUUID() },
    { platform: 'x' },
    { purpose: 'channel-token' },
  ])
    assert.throws(
      () => cipher.decrypt({ ...binding, ...change }, sealed),
      error => error instanceof SocialError && error.code === 'account-unavailable',
      JSON.stringify(change),
    );
  const { credentialVersion, ...pkce } = binding;
  assert.equal(credentialVersion, 5);
  assert.throws(() => cipher.decrypt({ ...pkce, purpose: 'pkce' }, sealed), SocialError);
  assert.throws(() => cipher.encrypt({ ...binding, extra: 1 }, 'x'), SocialError);
  const rotated = socialCredentialCipher({ activeKeyId: 'k2', keys: { k1: 'ab'.repeat(32), k2: 'cd'.repeat(32) } });
  assert.equal(rotated.decrypt(binding, sealed), 'token-value', 'an older key still opens its envelopes');
  assert.equal(rotated.encrypt(binding, 'v').keyId, 'k2');
});
