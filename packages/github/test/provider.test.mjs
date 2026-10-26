import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { authorizationUrl, exchange, githubConfiguration, identity, refresh } from '../src/provider.ts';
import { credentialCipher } from '../src/credentials.ts';
import { callbackSchema } from '../src/contracts.ts';

test('GitHub callbacks accept only GitHub as the RFC 9207 issuer', () => {
  const state = `f3edbb66-114f-4cd6-9fa5-b4103c64553f.${'a'.repeat(43)}`;
  assert.deepEqual(callbackSchema.parse({ code: 'provider-code', iss: 'https://github.com/login/oauth', state }), {
    code: 'provider-code',
    iss: 'https://github.com/login/oauth',
    state,
  });
  assert.deepEqual(callbackSchema.parse({ code: 'provider-code', state }), { code: 'provider-code', state });
  assert.equal(
    callbackSchema.safeParse({ error: 'access_denied', iss: 'https://github.com/login/oauth', state }).success,
    true,
  );
  for (const iss of ['https://attacker.example/login/oauth', 'https://github.com/login/oauth/', ''])
    assert.equal(callbackSchema.safeParse({ code: 'provider-code', iss, state }).success, false);
  assert.equal(callbackSchema.safeParse({ code: 'provider-code', state, extra: 'value' }).success, false);
});

const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  redirectUri: 'http://127.0.0.1:5218/github/callback',
};
test('GitHub configuration distinguishes disabled, complete and partial configuration', () => {
  assert.equal(githubConfiguration({}), null);
  assert.throws(() => githubConfiguration({ GITHUB_OAUTH_CLIENT_ID: '' }), /Invalid GitHub/);
  assert.throws(() => githubConfiguration({ GITHUB_OAUTH_CLIENT_ID: 'partial' }), /Invalid GitHub/);
  const env = {
    GITHUB_OAUTH_CLIENT_ID: config.clientId,
    GITHUB_OAUTH_CLIENT_SECRET: config.clientSecret,
    GITHUB_OAUTH_REDIRECT_URI: config.redirectUri,
  };
  assert.deepEqual(githubConfiguration(env), config);
  for (const redirect of [
    'http://remote.test/github/callback',
    'https://user:password@host/github/callback',
    'https://host/github/callback?next=bad',
    'https://host/wrong',
  ])
    assert.throws(() => githubConfiguration({ ...env, GITHUB_OAUTH_REDIRECT_URI: redirect }));
});
test('OAuth uses S256, account selection, form exchange and stable numeric identity', async () => {
  const verifier = 'v'.repeat(43);
  const url = new URL(authorizationUrl(config, 'state-value', verifier));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  const token = await exchange(config, 'code', verifier, async (url, init) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Accept, 'application/json');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code: 'code',
      code_verifier: verifier,
    });
    return Response.json({ access_token: 'synthetic-token', token_type: 'bearer', scope: 'repo,user' });
  });
  assert.deepEqual(token, {
    accessToken: 'synthetic-token',
    scopes: ['repo', 'user'],
    expiresIn: null,
    refreshToken: null,
    refreshExpiresIn: null,
  });
  assert.deepEqual(
    await identity(token.accessToken, async (url, init) => {
      assert.equal(url, 'https://api.github.com/user');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
      return Response.json({
        id: 1234,
        login: 'octocat',
        email: 'not-retained@example.test',
        avatar_url: 'https://untrusted.test',
      });
    }),
    { id: '1234', login: 'octocat' },
  );
  const bare = await exchange(config, 'code', verifier, async () =>
    Response.json({ access_token: 'token', token_type: 'bearer', scope: '' }),
  );
  assert.deepEqual(bare.scopes, []);
  await assert.rejects(identity('token', async () => Response.json({ id: 1, login: '<script>' })));
  await assert.rejects(
    identity('token', async () => new Response('x'.repeat(65537))),
    /account-unavailable/,
  );
});
test('key rotation and authenticated encryption bind workspace, member, account, generation and purpose', () => {
  const binding = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    membershipId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    purpose: 'token',
  };
  const old = credentialCipher({ activeKeyId: 'old', keys: { old: 'ab'.repeat(32) } });
  const value = old.encrypt(binding, 'private-token');
  const next = credentialCipher({ activeKeyId: 'new', keys: { old: 'ab'.repeat(32), new: 'cd'.repeat(32) } });
  assert.equal(next.decrypt(binding, value), 'private-token');
  assert.equal(next.encrypt(binding, 'next-token').keyId, 'new');
  for (const change of [
    { workspaceId: binding.accountId },
    { accountId: binding.workspaceId },
    { membershipId: binding.accountId },
    { generation: 2 },
    { purpose: 'pkce' },
  ])
    assert.throws(() => next.decrypt({ ...binding, ...change }, value));
  assert.throws(() => credentialCipher({ activeKeyId: 'new', keys: { new: 'cd'.repeat(32) } }).decrypt(binding, value));
  assert.equal(JSON.stringify(value).includes('private-token'), false);
});

test('refresh sends the single-use refresh token and treats an error body as a rejected credential', async () => {
  const granted = await refresh(config, 'refresh-old', async (url, init) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    });
    return Response.json({
      access_token: 'access-new',
      token_type: 'bearer',
      expires_in: 28800,
      refresh_token: 'refresh-new',
      refresh_token_expires_in: 15811200,
    });
  });
  assert.deepEqual(granted, {
    accessToken: 'access-new',
    expiresIn: 28800,
    refreshToken: 'refresh-new',
    refreshExpiresIn: 15811200,
  });
  await assert.rejects(
    refresh(config, 'refresh-old', async () => Response.json({ error: 'bad_refresh_token' })),
    /github-credential-rejected/,
  );
  await assert.rejects(
    refresh(config, 'refresh-old', async () => new Response('', { status: 502 })),
    /account-unavailable/,
  );
});

test('a refresh is not started after its admission deadline, and an admitted one is never cut short', async () => {
  let calls = 0;
  await assert.rejects(
    refresh(
      config,
      'refresh-old',
      async () => {
        calls++;
        return Response.json({});
      },
      Date.now() - 1,
    ),
    /account-unavailable/,
  );
  assert.equal(calls, 0);
  const granted = await refresh(
    config,
    'refresh-old',
    async (_url, init) => {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 300);
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      return Response.json({
        access_token: 'access-new',
        token_type: 'bearer',
        expires_in: 28800,
        refresh_token: 'refresh-new',
        refresh_token_expires_in: 15811200,
      });
    },
    Date.now() + 20,
  );
  assert.equal(granted.refreshToken, 'refresh-new');
});
