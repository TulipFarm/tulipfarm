import assert from 'node:assert/strict';
import test from 'node:test';
import { memberProvider } from '../src/member-provider.ts';
import { slackLinkFailure } from '../src/link-diagnostics.ts';
import { memberProviderFixture } from './member-provider-fixture.mjs';

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/identity',
    operationalRedirectUri: 'https://api.example.test/complete',
    scopeApproval: { userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'] },
  },
};

test('operational exchange accepts the production user-token shape and proves its owner with auth.test', async () => {
  const fixture = await memberProviderFixture(config);
  const provider = memberProvider(config, fixture.fetcher);
  assert.deepEqual(await provider.operational('code', 'verifier'), {
    teamId: 'TONE',
    userId: 'UPERSON',
    scopes: config.memberLinking.scopeApproval.userScopes,
    token: 'xoxp-synthetic-user-token',
    refresh_token: undefined,
    expires_in: undefined,
  });
});

test('auth.test owner, team, scopes and token kind decide acceptance', async () => {
  for (const [next, expected] of [
    [{ scopes: 'channels:history' }, 'slack-scope-missing'],
    [{ token: 'xoxb-bot-token' }, 'invalid-slack-data'],
    [{ rotating: true }, 'invalid-slack-data'],
    [{ deny: true }, 'slack-token-exchange-failed'],
  ]) {
    const fixture = await memberProviderFixture(config);
    fixture.set(next);
    await assert.rejects(
      memberProvider(config, fixture.fetcher).operational('code', 'verifier'),
      error => slackLinkFailure(error)['error.type'] === expected,
    );
  }
  const fixture = await memberProviderFixture(config);
  const fetcher = async (url, init) => {
    const response = await fixture.fetcher(url, init);
    if (!String(url).endsWith('/oauth.v2.user.access')) return response;
    return Response.json({ ...(await response.json()), team: { id: 'TOTHER' } });
  };
  await assert.rejects(memberProvider(config, fetcher).operational('code', 'verifier'), /slack-identity-mismatch/);
  const bot = async (url, init) =>
    String(url).endsWith('/auth.test')
      ? Response.json(
          { ok: true, team_id: 'TONE', user_id: 'UPERSON', bot_id: 'BBOT' },
          { headers: { 'x-oauth-scopes': 'channels:history' } },
        )
      : fixture.fetcher(url, init);
  await assert.rejects(
    memberProvider(config, bot).operational('code', 'verifier'),
    error => slackLinkFailure(error)['error.type'] === 'invalid-slack-data',
  );
});
