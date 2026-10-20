import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { slackCredentialCipher, slackConfigurationSchema } from '../src/index.ts';
import { exchangeCode } from '../src/provider.ts';

export const config = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic-client-secret',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
  scopeApproval: { reference: 'synthetic-fixture-only', botScopes: ['chat:write', 'app_mentions:read'] },
};
test('scope approval is explicit and redirects cannot carry credentials or query state', () => {
  assert.deepEqual(slackConfigurationSchema.parse(config), config);
  for (const value of [
    { ...config, scopeApproval: undefined },
    { ...config, scopeApproval: { botScopes: ['chat:write'], reference: '' } },
    ...[
      'http://api.example.test/callback',
      'https://user:pass@api.example.test/callback',
      'https://api.example.test/callback?x=1',
    ].map(redirectUri => ({ ...config, redirectUri })),
  ]) {
    assert.equal(slackConfigurationSchema.safeParse(value).success, false);
  }
});
test('bot encryption authenticates workspace, installation, generation and key while permitting key rollover', () => {
  const cipher = slackCredentialCipher({ activeKeyId: 'old', keys: { old: 'ab'.repeat(32) } });
  const binding = { workspaceId: randomUUID(), installationId: randomUUID(), generation: 1, kind: 'bot' };
  const envelope = cipher.encrypt(binding, 'xoxb-private');
  assert.equal(cipher.decrypt(binding, envelope), 'xoxb-private');
  const rotated = slackCredentialCipher({ activeKeyId: 'new', keys: { old: 'ab'.repeat(32), new: 'cd'.repeat(32) } });
  assert.equal(rotated.decrypt(binding, envelope), 'xoxb-private');
  assert.equal(rotated.encrypt(binding, 'xoxb-new').keyId, 'new');
  assert.equal(JSON.stringify(envelope).includes('xoxb-private'), false);
  for (const changed of [
    { ...binding, workspaceId: randomUUID() },
    { ...binding, installationId: randomUUID() },
    { ...binding, generation: 2 },
  ]) {
    assert.throws(() => cipher.decrypt(changed, envelope), /slack-credential-unavailable/);
  }
});
test('OAuth exchange is bounded, accepts complete rotation and rejects incomplete or org tokens', async () => {
  const oauth = {
    ok: true,
    app_id: 'ATEST',
    team: { id: 'TONE' },
    token_type: 'bot',
    bot_user_id: 'UBOT',
    access_token: 'xoxb-private',
    scope: 'chat:write',
  };
  assert.deepEqual(
    await exchangeCode(config, 'code', async (url, request) => {
      assert.equal(url, 'https://slack.com/api/oauth.v2.access');
      assert.equal(request.redirect, 'error');
      assert.equal(request.body.get('redirect_uri'), config.redirectUri);
      return Response.json(oauth);
    }),
    oauth,
  );
  const rotating = { ...oauth, access_token: 'xoxe.xoxb-renewed', refresh_token: 'xoxe-new', expires_in: 43200 };
  assert.deepEqual(await exchangeCode(config, 'code', async () => Response.json(rotating)), rotating);
  for (const payload of [
    { ...oauth, app_id: 'AOTHER' },
    { ...oauth, is_enterprise_install: true },
    { ...oauth, refresh_token: 'refresh' },
    { ...oauth, expires_in: 10 },
    { ...oauth, padding: 'x'.repeat(33000) },
  ]) {
    await assert.rejects(
      exchangeCode(config, 'code', async () => Response.json(payload)),
      /slack-oauth-unavailable/,
    );
  }
});
test('member-link consent requires an approved non-OIDC read scope set and supported distribution', () => {
  const memberLinking = {
    identityRedirectUri: 'https://api.example.test/v1/slack/link/identity',
    operationalRedirectUri: 'https://api.example.test/v1/slack/link/complete',
    distribution: 'internal',
    scopeApproval: {
      reference: 'synthetic',
      userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
    },
  };
  assert.deepEqual(slackConfigurationSchema.parse({ ...config, memberLinking }).memberLinking, memberLinking);
  for (const changed of [
    { ...memberLinking, distribution: 'unlisted' },
    { ...memberLinking, scopeApproval: { reference: '', userScopes: memberLinking.scopeApproval.userScopes } },
    { ...memberLinking, scopeApproval: { reference: 'synthetic', userScopes: ['chat:write'] } },
    {
      ...memberLinking,
      scopeApproval: { reference: 'synthetic', userScopes: [...memberLinking.scopeApproval.userScopes, 'openid'] },
    },
  ])
    assert.equal(slackConfigurationSchema.safeParse({ ...config, memberLinking: changed }).success, false);
});
test('per-user encryption refuses a different user, membership, identity or bot fallback', () => {
  const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
  const binding = {
    workspaceId: randomUUID(),
    installationId: randomUUID(),
    generation: 1,
    kind: 'user',
    identityId: randomUUID(),
    membershipId: randomUUID(),
    slackUserId: 'UPERSON',
  };
  const envelope = cipher.encrypt(binding, 'xoxp-private');
  assert.equal(cipher.decrypt(binding, envelope), 'xoxp-private');
  for (const changed of [
    { ...binding, slackUserId: 'UOTHER' },
    { ...binding, membershipId: randomUUID() },
    { ...binding, identityId: randomUUID() },
    { workspaceId: binding.workspaceId, installationId: binding.installationId, generation: 1, kind: 'bot' },
  ])
    assert.throws(() => cipher.decrypt(changed, envelope), /slack-credential-unavailable/);
});
