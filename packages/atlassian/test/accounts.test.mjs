import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  accountAuthorizationUrl,
  accountConfigurations,
  accountIdentity,
  exchangeAccountToken,
  rejectReflectedCredentials,
} from '../dist/account-provider.js';
import { accountCredentialCipher } from '../dist/account-credentials.js';
import { AccountError } from '../src/account-contracts.ts';

const config = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.example.test/v1/atlassian/oauth/callback',
  scopes: ['read:me', 'offline_access'],
};
const response = {
  access_token: 'synthetic-access',
  refresh_token: 'synthetic-refresh',
  expires_in: 3600,
  token_type: 'Bearer',
};

test('protocol-specific authorization and token contracts use only pinned endpoints', async () => {
  for (const protocol of ['atlassian-mcp', 'atlassian-rest', 'trello']) {
    const url = new URL(accountAuthorizationUrl(protocol, config, 'session-state', 'pkce-verifier'));
    assert.equal(url.origin, protocol === 'atlassian-mcp' ? 'https://mcp.atlassian.com' : 'https://auth.atlassian.com');
    assert.equal(url.pathname, protocol === 'atlassian-mcp' ? '/v1/authorize' : '/authorize');
    assert.equal(url.searchParams.get('state'), 'session-state');
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(url.searchParams.get('audience'), protocol === 'atlassian-rest' ? 'api.atlassian.com' : null);
    assert.equal(
      url.searchParams.get('code_challenge'),
      protocol === 'atlassian-rest' ? null : createHash('sha256').update('pkce-verifier').digest('base64url'),
    );
    for (const grant of [
      { kind: 'code', code: 'one-time-code', verifier: 'pkce-verifier' },
      { kind: 'refresh', token: 'rotating-refresh' },
    ]) {
      let calls = 0;
      const result = await exchangeAccountToken(protocol, config, grant, async (url, init) => {
        calls++;
        assert.equal(
          url,
          protocol === 'atlassian-mcp'
            ? 'https://mcp.atlassian.com/v1/token'
            : 'https://auth.atlassian.com/oauth/token',
        );
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal);
        const body =
          protocol === 'atlassian-mcp' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
        assert.equal(body.client_id, config.clientId);
        assert.equal(body.client_secret, config.clientSecret);
        if (grant.kind === 'code') {
          assert.equal(body.grant_type, 'authorization_code');
          assert.equal(body.code, grant.code);
          assert.equal(body.redirect_uri, config.redirectUri);
          assert.equal(body.code_verifier, protocol === 'atlassian-rest' ? undefined : grant.verifier);
        } else assert.equal(body.refresh_token, grant.token);
        return Response.json(response);
      });
      assert.deepEqual(result, response);
      assert.equal(calls, 1);
    }
  }
});

test('missing, partial, unsafe and unqualified identity-scope configuration is disabled', () => {
  assert.deepEqual(accountConfigurations({}), {});
  assert.deepEqual(accountConfigurations({ TRELLO_CLIENT_ID: 'partial' }), {});
  const env = {
    TRELLO_CLIENT_ID: config.clientId,
    TRELLO_CLIENT_SECRET: config.clientSecret,
    TRELLO_REDIRECT_URI: config.redirectUri,
    TRELLO_SCOPES: 'read:member:trello offline_access',
  };
  assert.deepEqual(accountConfigurations(env), {
    trello: { ...config, scopes: ['read:member:trello', 'offline_access'] },
  });
  for (const uri of [
    'http://foreign.example/callback',
    'https://user:password@example.test/callback',
    `${config.redirectUri}?injected=true`,
  ])
    assert.deepEqual(accountConfigurations({ ...env, TRELLO_REDIRECT_URI: uri }), {});
  assert.deepEqual(accountConfigurations({ ...env, TRELLO_SCOPES: 'read:board:trello' }), {});
});

test('provider identity is fetched from the official REST APIs and MCP stays grant-qualified', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push(url);
    assert.equal(init.headers.Authorization, 'Bearer synthetic-access');
    if (url === 'https://api.atlassian.com/me')
      return Response.json({ account_id: 'verified-atlassian-account', name: 'Test person', extra: 'discarded' });
    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources')
      return Response.json([
        { id: 'cloud-id', name: 'Test site', url: 'https://example.atlassian.net', scopes: ['read:page:confluence'] },
      ]);
    if (url === 'https://api.trello.com/1/members/me?fields=id,username')
      return Response.json({ id: 'abcdef123456abcdef123456', username: 'test-person' });
    assert.fail(url);
  };
  assert.equal(
    (await accountIdentity('atlassian-rest', 'synthetic-access', 'grant', fetcher)).identity.id,
    'verified-atlassian-account',
  );
  assert.equal(
    (await accountIdentity('trello', 'synthetic-access', 'grant', fetcher)).identity.id,
    'abcdef123456abcdef123456',
  );
  assert.deepEqual(await accountIdentity('atlassian-mcp', 'synthetic-access', 'grant-id', fetcher), {
    identity: { id: 'grant-id', label: 'Atlassian MCP grant', qualification: 'grant-bound-needs-qualification' },
    resources: [],
  });
  assert.equal(requests.length, 3);
});

test('bounded exchanges sanitize failures and never retry', async () => {
  for (const provider of [
    async () => {
      throw new Error('synthetic-secret provider diagnostic');
    },
    async () => new Response('synthetic-secret', { status: 400 }),
    async () => new Response('x'.repeat(131073)),
    async () => Response.json({ ...response, expires_in: 0 }),
    async () => Response.json({ ...response, token_type: 'Basic' }),
  ]) {
    let calls = 0;
    await assert.rejects(
      exchangeAccountToken('trello', config, { kind: 'refresh', token: 'private-token' }, (...args) => {
        calls++;
        return provider(...args);
      }),
      error => error.message === 'account-unavailable' && !error.cause,
    );
    assert.equal(calls, 1);
  }
});

test('credential envelope binds workspace, account, protocol, generation and purpose and supports old keys', () => {
  const keyring = { activeKeyId: 'old', keys: { old: 'ab'.repeat(32) } };
  const cipher = accountCredentialCipher(keyring);
  const binding = {
    workspaceId: randomUUID(),
    accountId: randomUUID(),
    protocol: 'trello',
    generation: 1,
    purpose: 'tokens',
  };
  const encrypted = cipher.encrypt(binding, 'private-credential');
  assert.equal(JSON.stringify(encrypted).includes('private-credential'), false);
  assert.equal(cipher.decrypt(binding, encrypted), 'private-credential');
  assert.equal(
    cipher.decrypt(
      { ...binding, workspaceId: binding.workspaceId.toUpperCase(), accountId: binding.accountId.toUpperCase() },
      encrypted,
    ),
    'private-credential',
  );
  for (const patch of [
    { workspaceId: randomUUID() },
    { accountId: randomUUID() },
    { protocol: 'atlassian-mcp' },
    { generation: 2 },
    { purpose: 'pkce' },
  ])
    assert.throws(() => cipher.decrypt({ ...binding, ...patch }, encrypted), /account-unavailable/);
  const rotated = accountCredentialCipher({ activeKeyId: 'new', keys: { ...keyring.keys, new: 'cd'.repeat(32) } });
  assert.equal(rotated.decrypt(binding, encrypted), 'private-credential');
  assert.throws(
    () => cipher.decrypt(binding, { ...encrypted, tag: Buffer.alloc(16).toString('base64') }),
    /account-unavailable/,
  );
});

test('AccountError runs through native Node TypeScript without parameter-property transforms', () => {
  const error = new AccountError('account-authorization-denied');
  assert.equal(error.code, 'account-authorization-denied');
  assert.equal(error.message, 'account-authorization-denied');
  assert.ok(error instanceof Error);
});

test('identity outputs reject reflected tokens after JSON, URL, HTML and base64 decoding', async () => {
  const token = 'synthetic-access';
  const echoes = [
    token,
    '%73ynthetic-access',
    '%2573ynthetic-access',
    '\\u0073ynthetic-access',
    '\\x73ynthetic-access',
    '&#115;ynthetic-access',
    '&#x73;ynthetic-access',
    Buffer.from(token).toString('base64'),
  ];
  for (const echo of echoes) {
    for (const protocol of ['trello', 'atlassian-rest'])
      await assert.rejects(
        accountIdentity(protocol, token, 'grant', async url => {
          if (url.includes('/1/members/me')) return Response.json({ id: 'abcdef123456abcdef123456', username: echo });
          if (url.endsWith('/me')) return Response.json({ account_id: 'verified-id', name: echo });
          return Response.json([]);
        }),
        error => error.message === 'account-unavailable' && !error.cause,
      );
  }
  await assert.rejects(
    accountIdentity('atlassian-rest', token, 'grant', async url =>
      url.endsWith('/me')
        ? new Response('{"account_id":"verified-id","name":"\\u0073ynthetic-access"}')
        : Response.json([]),
    ),
    /account-unavailable/,
  );
  for (const field of ['id', 'name', 'scopes'])
    await assert.rejects(
      accountIdentity('atlassian-rest', token, 'grant', async url =>
        url.endsWith('/me')
          ? Response.json({ account_id: 'verified-id', name: 'Name' })
          : Response.json([
              {
                id: 'cloud-id',
                name: 'Site',
                url: 'https://example.atlassian.net',
                scopes: ['read:me'],
                [field]: field === 'scopes' ? [token] : token,
              },
            ]),
      ),
      /account-unavailable/,
    );
});

test('resource URLs reject script schemes, foreign origins, userinfo, paths and escaped host tricks', async () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,secret',
    'http://example.atlassian.net',
    'https://attacker.example',
    'https://example.atlassian.net.attacker.example',
    'https://user:pass@example.atlassian.net',
    'https://example.atlassian.net?token=secret',
    'https://example.atlassian.net/#secret',
    'https://example.atlassian.net/secret',
    'https://example.atlassian.net:8443',
    'https://%65xample.atlassian.net',
    'https://example.atlassian.net\\@attacker.example',
    'https://example.atlassian.net\n.attacker.example',
  ]) {
    await assert.rejects(
      accountIdentity('atlassian-rest', 'synthetic-access', 'grant', async endpoint =>
        endpoint.endsWith('/me')
          ? Response.json({ account_id: 'verified-id', name: 'Name' })
          : Response.json([{ id: 'cloud-id', name: 'Site', url, scopes: ['read:me'] }]),
      ),
      /account-unavailable/,
    );
  }
});

test('credential reflection rejects encoded object keys through nested objects and arrays', () => {
  const token = 'synthetic-access-token';
  const encoded = Buffer.from(token).toString('base64');
  for (const key of [token, encoded, `%${encoded.charCodeAt(0).toString(16)}${encoded.slice(1)}`]) {
    for (const value of [
      { [key]: 'innocent value' },
      { structuredContent: { nested: { [key]: 'innocent value' } } },
      { structuredContent: { nested: [[{ [key]: 'innocent value' }]] } },
      [[{ nested: { [key]: 'innocent value' } }]],
    ])
      assert.throws(
        () => rejectReflectedCredentials(value, [token]),
        error => error.message === 'account-unavailable' && !error.cause,
      );
  }
  assert.doesNotThrow(() =>
    rejectReflectedCredentials({ structuredContent: { nested: [[{ issue: 'OPS-1' }]] } }, [token]),
  );
});
