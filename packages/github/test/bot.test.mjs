import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { botRepository, githubBot } from '../src/bot.ts';

test('only repository work may run as the bot', () => {
  assert.equal(
    botRepository({ kind: 'issue.create', owner: 'OctoCat', repo: 'Hello', title: 't', body: 'b' }),
    'octocat/hello',
  );
  assert.equal(botRepository({ kind: 'pull.create-fork', owner: 'o', repo: 'r' }), null);
  assert.equal(botRepository({ kind: 'repository.create', owner: 'o', repo: 'r' }), null);
  assert.equal(botRepository({ kind: 'project.item-add', owner: 'o', repo: 'r' }), null);
});

test('a bad bot setting fails bot credentials, not bot construction', async () => {
  assert.equal(githubBot({}), null);
  const missing = githubBot({ GITHUB_APP_PRIVATE_KEY: 'not-a-key' });
  assert.ok(missing);
  await assert.rejects(missing.credential({}, 'o', 'r'), /requires GITHUB_WEBHOOK_APP_ID/);
  const invalid = githubBot({
    GITHUB_APP_PRIVATE_KEY: 'not-a-key',
    GITHUB_WEBHOOK_APP_ID: '1',
    GITHUB_OAUTH_CLIENT_ID: 'Iv1.x',
    GITHUB_APP_SLUG: 'tulipfarm',
  });
  await assert.rejects(invalid.credential({}, 'o', 'r'));
});

test('the bot credential is a repository token with the bot identity', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const calls = [];
  const bot = githubBot(
    {
      GITHUB_APP_PRIVATE_KEY: key.replaceAll('\n', '\\n'),
      GITHUB_WEBHOOK_APP_ID: '1',
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.x',
      GITHUB_APP_SLUG: 'tulipfarm',
    },
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push([init.method ?? 'GET', path, init.body ? JSON.parse(init.body) : null]);
      if (path === '/repos/octocat/hello/installation')
        return Response.json({
          id: 7,
          app_id: 1,
          account: { id: 5, login: 'octocat', type: 'User' },
          repository_selection: 'selected',
          suspended_at: null,
          permissions: { issues: 'write' },
          events: [],
        });
      if (path === '/app/installations/7/access_tokens')
        return Response.json(
          {
            token: `ghs_${'x'.repeat(36)}`,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            repositories: [{ full_name: 'octocat/hello' }],
          },
          { status: 201 },
        );
      if (path === '/users/tulipfarm%5Bbot%5D') return Response.json({ id: 999, login: 'tulipfarm[bot]', type: 'Bot' });
      return Response.json({}, { status: 404 });
    },
  );
  const member = { accessToken: 'member', identity: { id: '1', login: 'm' }, scopes: ['repo'] };
  const credential = await bot.credential(member, 'octocat', 'hello');
  assert.equal(credential.app, true);
  assert.deepEqual(credential.scopes, []);
  assert.deepEqual(credential.identity, { id: '999', login: 'tulipfarm[bot]' });
  assert.notEqual(credential.accessToken, 'member');
  assert.deepEqual(calls.find(call => call[1].endsWith('/access_tokens'))[2], { repositories: ['hello'] });
});
