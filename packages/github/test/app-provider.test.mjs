import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubAppProvider, GitHubAppError } from '../src/app-provider.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '100', clientId: 'Iv1.fixture', privateKey: keys.privateKey };
const installation = () => ({
  id: 200,
  app_id: 100,
  account: { id: 300, login: 'fixture-org', type: 'Organization' },
  repository_selection: 'selected',
  suspended_at: null,
  permissions: { pull_requests: 'read', issues: 'read', metadata: 'read' },
  events: ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment'],
});
const token = () => ({
  token: `ghs_APPID_${'fixture'.repeat(50)}`,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  permissions: { pull_requests: 'read', issues: 'read', metadata: 'read' },
  repositories: [{ id: 400 }],
});
const failure = code => error => error instanceof GitHubAppError && error.code === code;

test('App requests use verified RS256 JWTs with bounded expiry and no redirects', async () => {
  const provider = createGitHubAppProvider({
    ...config,
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.github.com/app/installations/200');
      assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers),
        authorization = headers.get('authorization');
      assert.equal(headers.get('x-github-api-version'), '2026-03-10');
      assert.ok(authorization.startsWith('Bearer '));
      const [header, payload, signature] = authorization.slice(7).split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
      const claims = JSON.parse(Buffer.from(payload, 'base64url')),
        now = Math.floor(Date.now() / 1000);
      assert.equal(claims.iss, config.clientId);
      assert.ok(claims.iat >= now - 61 && claims.iat <= now - 59);
      assert.ok(claims.exp > now && claims.exp <= now + 600);
      assert.equal(
        verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')),
        true,
      );
      return Response.json(installation());
    },
  });
  assert.equal((await provider.installation('200')).account.id, '300');
});

test('installation identity cannot be supplied by a mismatched provider response', async () => {
  for (const patch of [{ id: 201 }, { app_id: 101 }]) {
    const provider = createGitHubAppProvider({
      ...config,
      fetcher: async () => Response.json({ ...installation(), ...patch }),
    });
    await assert.rejects(provider.installation('200'), failure('identity-mismatch'));
  }
  const provider = createGitHubAppProvider({
    ...config,
    fetcher: async () => Response.json({ ...installation(), suspended_at: '2026-10-13T00:00:00Z' }),
  });
  assert.equal(
    (await provider.installation('200')).suspended_at,
    '2026-10-13T00:00:00Z',
    'suspension is returned, not hidden by an active default',
  );
});

test('installation tokens are read-only, single-repository and accept the current variable-length format', async () => {
  const fixture = token();
  const provider = createGitHubAppProvider({
    ...config,
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.github.com/app/installations/200/access_tokens');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        repository_ids: [400],
        permissions: { pull_requests: 'read', issues: 'read', metadata: 'read' },
      });
      return Response.json(fixture);
    },
  });
  assert.equal(
    await provider.withRepositoryToken('200', '400', async credential => {
      assert.equal(credential, fixture.token);
      return 'read completed';
    }),
    'read completed',
  );
  for (const patch of [
    { repositories: [{ id: 401 }] },
    { repositories: [{ id: 400 }, { id: 401 }] },
    { permissions: { ...fixture.permissions, pull_requests: 'write' } },
    { permissions: { ...fixture.permissions, contents: 'read' } },
    { expires_at: new Date(Date.now() - 1000).toISOString() },
    { expires_at: new Date(Date.now() + 7200000).toISOString() },
  ]) {
    const denied = createGitHubAppProvider({ ...config, fetcher: async () => Response.json({ ...fixture, ...patch }) });
    await assert.rejects(
      denied.withRepositoryToken('200', '400', async () => assert.fail('invalid token reached its caller')),
      GitHubAppError,
    );
  }
});

test('provider errors and malformed responses are explicit without copying remote bodies into errors', async () => {
  for (const [status, headers, code] of [
    [401, {}, 'access-denied'],
    [404, {}, 'access-denied'],
    [429, {}, 'rate-limited'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
    [503, {}, 'unavailable'],
  ]) {
    const provider = createGitHubAppProvider({
      ...config,
      fetcher: async () => new Response('private remote detail', { status, headers }),
    });
    await assert.rejects(
      provider.installation('200'),
      error => failure(code)(error) && !error.message.includes('private'),
    );
  }
  for (const body of ['{', JSON.stringify({ ...installation(), description: 'x'.repeat(131072) })]) {
    const provider = createGitHubAppProvider({
      ...config,
      fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(provider.installation('200'), failure('invalid-response'));
  }
  assert.throws(
    () => createGitHubAppProvider({ ...config, privateKey: keys.publicKey }),
    /Invalid GitHub App private key/,
  );
});

test('response size is bounded in bytes and transport failures never become successful reads', async () => {
  const raw = JSON.stringify(installation()).padEnd(131072);
  const accepted = createGitHubAppProvider({
    ...config,
    fetcher: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(raw, { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal((await accepted.installation('200')).id, '200');
  let cancelled = false;
  const oversized = createGitHubAppProvider({
    ...config,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(`${raw} `));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(oversized.installation('200'), failure('invalid-response'));
  assert.equal(cancelled, true);
  const invalidUtf8 = createGitHubAppProvider({
    ...config,
    fetcher: async () => new Response(Buffer.from([0xff]), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(invalidUtf8.installation('200'), failure('invalid-response'));
  for (const error of [new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError')]) {
    const provider = createGitHubAppProvider({
      ...config,
      fetcher: async () => {
        throw error;
      },
    });
    await assert.rejects(provider.installation('200'), failure('unavailable'));
  }
  const unexpected = new Error('local invariant failed');
  const provider = createGitHubAppProvider({
    ...config,
    fetcher: async () => {
      throw unexpected;
    },
  });
  await assert.rejects(provider.installation('200'), error => error === unexpected);
});

test('invalid IDs never reach the transport and callback errors are not retried or hidden', async () => {
  let requests = 0;
  const provider = createGitHubAppProvider({
    ...config,
    fetcher: async () => {
      requests++;
      return Response.json(token());
    },
  });
  for (const id of ['0', '../other', '200?scope=all']) await assert.rejects(provider.installation(id));
  await assert.rejects(
    provider.withRepositoryToken('200', '9007199254740993', async () => assert.fail('unsafe repository')),
  );
  assert.equal(requests, 0);
  const failure = new Error('authorized operation failed');
  await assert.rejects(
    provider.withRepositoryToken('200', '400', async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(requests, 1);
});
