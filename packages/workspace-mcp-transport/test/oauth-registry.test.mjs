import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createOAuthOperations,
  createRegistryCatalog,
  resolveRegistryEndpoint,
  MCP_OAUTH_REDIRECT_URI,
  MCP_OAUTH_CLIENT_ID,
} from '../dist/index.js';

const resource = 'https://mcp.example.test/tools';
const issuer = 'https://auth.example.test/tenant';
const binding = {
  resource,
  issuer,
  authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`,
  registrationEndpoint: `${issuer}/register`,
  metadataDocumentSupported: false,
  authMethods: ['none', 'client_secret_basic', 'client_secret_post'],
  scopes: ['read', 'write'],
  authorizationResponseIssuerSupported: true,
};
const client = { clientId: 'explicit-client', authMethod: 'none', issuer };
const metadata = {
  issuer,
  authorization_endpoint: binding.authorizationEndpoint,
  token_endpoint: binding.tokenEndpoint,
  registration_endpoint: binding.registrationEndpoint,
  code_challenge_methods_supported: ['S256'],
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: binding.authMethods,
  authorization_response_iss_parameter_supported: true,
};

async function httpFixture(t, handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {
      url: new URL(req.url, 'https://fixture.test'),
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    received.push(request);
    try {
      await handler(request, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const fetcher = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, init);
  };
  return { fetcher, received };
}
const json = (res, body, status = 200) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

test('one OAuth discovery deadline spans every fallback and cancellation stops traversal', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  let requests = 0;
  const operations = createOAuthOperations({
    fetcher: async (_url, init) => {
      requests++;
      if (requests === 1) return new Response(null, { status: 401 });
      if (requests === 2) return new Response('{}', { status: 404 });
      deadlines.find(item => item.milliseconds === 60000).controller.abort();
      assert.equal(init.signal.aborted, true);
      throw new Error('cancelled-private-diagnostic');
    },
  });
  await assert.rejects(operations.discoverOAuth({ endpoint: resource }), { code: 'oauth-discovery-failed' });
  assert.equal(requests, 3);
  assert.equal(deadlines.filter(item => item.milliseconds === 60000).length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(operations.discoverOAuth({ endpoint: resource, signal: controller.signal }), {
    code: 'oauth-discovery-failed',
  });
  assert.equal(requests, 3);
});

test('real HTTP OAuth discovers resource and issuer then binds PKCE, explicit client and token exchange', async t => {
  const f = await httpFixture(t, (req, res) => {
    if (req.url.pathname === '/tools')
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/resource"' }).end();
    else if (req.url.pathname === '/resource')
      json(res, { resource, authorization_servers: [issuer], scopes_supported: ['read', 'write'] });
    else if (req.url.pathname === '/.well-known/oauth-authorization-server/tenant') json(res, metadata);
    else if (req.url.pathname === '/tenant/token')
      json(res, {
        access_token: 'new-access-token',
        refresh_token: 'refresh-rotation',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read',
      });
    else json(res, {}, 404);
  });
  const operations = createOAuthOperations({ fetcher: f.fetcher, now: () => new Date('2026-10-02T12:00:00Z') });
  const discovered = await operations.discoverOAuth({ endpoint: resource });
  assert.deepEqual(discovered, binding);
  assert.deepEqual(await operations.registerOAuthClient({ binding, explicit: client }), client);
  const authorization = operations.createOAuthAuthorization({
    binding,
    client,
    state: 's'.repeat(43),
    scope: ['read'],
  });
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.searchParams.get('resource'), resource);
  assert.equal(url.searchParams.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(authorization.verifier).digest('base64url'),
  );
  const tokens = await operations.exchangeOAuthCode({
    binding,
    client,
    code: 'one-use-code',
    verifier: authorization.verifier,
    responseIssuer: issuer,
    scope: ['read'],
  });
  assert.deepEqual(tokens, {
    accessToken: 'new-access-token',
    refreshToken: 'refresh-rotation',
    expiresAt: '2026-10-02T13:00:00.000Z',
    issuer,
    resource,
    scopes: ['read'],
  });
  const sent = new URLSearchParams(f.received.at(-1).body);
  assert.equal(sent.get('resource'), resource);
  assert.equal(sent.get('code_verifier'), authorization.verifier);
  assert.equal(sent.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI);
  assert.equal(sent.get('client_id'), client.clientId);
});

test('resource mismatch, issuer mix-up, missing PKCE and ambiguous issuer prevent authorization', async t => {
  for (const mode of ['resource', 'issuer', 'pkce', 'ambiguous'])
    await t.test(mode, async t => {
      const f = await httpFixture(t, (req, res) => {
        if (req.url.pathname.includes('oauth-protected-resource'))
          json(res, {
            resource: mode === 'resource' ? 'https://other.example.test/tools' : resource,
            authorization_servers: mode === 'ambiguous' ? [issuer, 'https://other.example.test'] : [issuer],
          });
        else if (req.url.pathname.includes('oauth-authorization-server'))
          json(res, {
            ...metadata,
            ...(mode === 'issuer' ? { issuer: 'https://other.example.test' } : {}),
            ...(mode === 'pkce' ? { code_challenge_methods_supported: ['plain'] } : {}),
          });
        else json(res, {}, 404);
      });
      const operations = createOAuthOperations({ fetcher: f.fetcher });
      await assert.rejects(operations.discoverOAuth({ endpoint: resource }), { code: 'oauth-binding-denied' });
      assert.equal(f.received.filter(req => req.method === 'POST').length, 0);
    });
});

test('registration preference is explicit, advertised metadata, dynamic, then visible requirement', async t => {
  const f = await httpFixture(t, (req, res) =>
    json(res, {
      client_id: 'dynamic-client',
      token_endpoint_auth_method: 'none',
      redirect_uris: [MCP_OAUTH_REDIRECT_URI],
    }),
  );
  const operations = createOAuthOperations({ fetcher: f.fetcher });
  assert.deepEqual(
    await operations.registerOAuthClient({
      binding: { ...binding, metadataDocumentSupported: true },
      explicit: client,
    }),
    client,
  );
  assert.equal(
    (await operations.registerOAuthClient({ binding: { ...binding, metadataDocumentSupported: true } })).clientId,
    MCP_OAUTH_CLIENT_ID,
  );
  assert.equal(f.received.length, 0);
  assert.equal((await operations.registerOAuthClient({ binding })).clientId, 'dynamic-client');
  assert.equal(f.received.length, 1);
  assert.deepEqual(JSON.parse(f.received[0].body).redirect_uris, [MCP_OAUTH_REDIRECT_URI]);
  await assert.rejects(operations.registerOAuthClient({ binding: { ...binding, registrationEndpoint: undefined } }), {
    code: 'oauth-registration-required',
  });
});

test('OAuth discovery cancellation stops metadata fallback traversal with one shared deadline', async t => {
  const entered = Promise.withResolvers();
  const f = await httpFixture(t, (req, res) => {
    if (req.url.pathname === '/tools') json(res, {}, 401);
    else if (req.url.pathname === '/.well-known/oauth-protected-resource/tools') json(res, {}, 404);
    else if (req.url.pathname === '/.well-known/oauth-protected-resource')
      json(res, { resource, authorization_servers: [issuer] });
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      entered.resolve();
    }
  });
  const signals = [];
  const controller = new AbortController();
  const operations = createOAuthOperations({
    fetcher: (url, init) => {
      signals.push(init.signal);
      return f.fetcher(url, init);
    },
  });
  const pending = operations.discoverOAuth({ endpoint: resource, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'oauth-discovery-failed' });
  assert.equal(f.received.length, 4);
  assert.equal(
    signals.every(signal => signal.aborted),
    true,
  );
});

test('OAuth operations isolate concurrent clients and rotation without hidden in-memory state', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await httpFixture(t, async (req, res) => {
    const params = new URLSearchParams(req.body);
    if (params.get('refresh_token') === 'first-refresh') {
      entered.resolve();
      await release.promise;
    }
    json(res, {
      access_token: `${params.get('client_id')}-access`,
      refresh_token: `${params.get('client_id')}-rotated`,
      token_type: 'Bearer',
      expires_in: 60,
    });
  });
  const operations = createOAuthOperations({ fetcher: f.fetcher });
  const first = operations.refreshOAuthToken({
    binding,
    client: { ...client, clientId: 'first' },
    refreshToken: 'first-refresh',
    scope: ['read'],
  });
  await entered.promise;
  const second = await operations.refreshOAuthToken({
    binding,
    client: { ...client, clientId: 'second' },
    refreshToken: 'second-refresh',
    scope: ['write'],
  });
  release.resolve();
  assert.equal((await first).accessToken, 'first-access');
  assert.equal(second.accessToken, 'second-access');
  assert.equal(second.refreshToken, 'second-rotated');
  assert.deepEqual(second.scopes, ['write']);
  assert.deepEqual(
    f.received.map(req => new URLSearchParams(req.body).get('resource')),
    [resource, resource],
  );
});

test('OAuth errors cannot reflect codes, client secrets, refresh tokens or private remote errors', async t => {
  const f = await httpFixture(t, (_req, res) =>
    json(
      res,
      { error: 'invalid_grant', error_description: 'one-use-code client-private-secret refresh-private-secret' },
      400,
    ),
  );
  const operations = createOAuthOperations({ fetcher: f.fetcher });
  await assert.rejects(
    operations.exchangeOAuthCode({
      binding,
      client: { ...client, authMethod: 'client_secret_post', clientSecret: 'client-private-secret' },
      code: 'one-use-code',
      verifier: 'v'.repeat(43),
      responseIssuer: issuer,
    }),
    error => {
      assert.equal(error.message, 'mcp-oauth-token-failed');
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('private-secret'), false);
      return true;
    },
  );
  await assert.rejects(operations.refreshOAuthToken({ binding, client, refreshToken: 'refresh-private-secret' }), {
    code: 'oauth-token-failed',
  });
  await assert.rejects(
    operations.exchangeOAuthCode({
      binding,
      client,
      code: 'one-use-code',
      verifier: 'v'.repeat(43),
      responseIssuer: 'https://wrong.example',
    }),
    { code: 'oauth-binding-denied' },
  );
  await assert.rejects(
    operations.exchangeOAuthCode({ binding, client, code: 'one-use-code', verifier: 'v'.repeat(43) }),
    { code: 'oauth-binding-denied' },
  );
  assert.equal(f.received.length, 2);
});

function record(name, { status = 'active', endpoint = 'https://mcp.example.test/tools', headers, version = '1' } = {}) {
  return {
    server: {
      name,
      version,
      description: `Tools for ${name}`,
      remotes: [{ type: 'streamable-http', url: endpoint, ...(headers ? { headers } : {}) }],
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': { status, updatedAt: '2026-10-02T00:00:00Z', isLatest: true },
    },
  };
}

test('Registry retains safe failure reasons without provider bodies and clears them after recovery', async t => {
  const cases = [
    ['catalog-http', () => new Response('PRIVATE', { status: 503 })],
    ['catalog-response', () => new Response('PRIVATE', { headers: { 'content-type': 'text/plain' } })],
    ['catalog-invalid-json', () => new Response('PRIVATE', { headers: { 'content-type': 'application/json' } })],
    ['catalog-invalid-schema', () => Response.json({ servers: [{ private: 'PRIVATE' }], metadata: {} })],
    [
      'catalog-invalid-timestamp',
      () => {
        const item = record('org/example');
        item._meta['io.modelcontextprotocol.registry/official'].updatedAt = 'PRIVATE';
        return Response.json({ servers: [item], metadata: {} });
      },
    ],
    ['catalog-cursor-loop', () => Response.json({ servers: [], metadata: { nextCursor: 'PRIVATE' } })],
    [
      'network-failed',
      () => {
        throw new Error('PRIVATE');
      },
    ],
  ];
  for (const [code, response] of cases)
    await t.test(code, async () => {
      let failing = true;
      const catalog = createRegistryCatalog({
        fetcher: async () => (failing ? response() : Response.json({ servers: [], metadata: {} })),
      });
      const failed = await catalog.refresh();
      assert.equal(failed.refreshFailed, true);
      assert.equal(failed.failureCode, code);
      assert.ok(failed.failureStage);
      assert.ok(failed.failureDiagnostics.attempts >= 1);
      assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
      failing = false;
      const recovered = await catalog.refresh();
      assert.equal(recovered.refreshFailed, false);
      assert.equal(recovered.failureCode, undefined);
      assert.equal(recovered.failureStage, undefined);
      assert.equal(recovered.failureDiagnostics, undefined);
    });
});

test('Registry captures exact HTTP status and failed-page diagnostics without response text or cursors', async () => {
  let attempts = 0;
  const first = JSON.stringify({ servers: [], metadata: { nextCursor: 'PRIVATE CURSOR' } });
  const catalog = createRegistryCatalog({
    fetcher: async () =>
      ++attempts === 1
        ? new Response(first, { headers: { 'content-type': 'application/json' } })
        : new Response('PRIVATE PROVIDER BODY', { status: 429, headers: { 'retry-after': 'PRIVATE HEADER' } }),
  });
  const failed = await catalog.refresh();
  assert.equal(failed.failureCode, 'catalog-http');
  assert.equal(failed.failureStage, 'catalog-fetch');
  assert.deepEqual(failed.failureDiagnostics, {
    httpStatus: 429,
    pageBytes: 0,
    receivedBytes: Buffer.byteLength(first),
    completedPages: 1,
    attempts: 2,
  });
  failed.failureDiagnostics.receivedBytes = 0;
  assert.equal(catalog.snapshot().failureDiagnostics.receivedBytes, Buffer.byteLength(first));
  assert.doesNotMatch(JSON.stringify(catalog.snapshot()), /PRIVATE/);
});

test('Registry distinguishes a stalled response body from a request deadline', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let sent = false;
  const catalog = createRegistryCatalog({
    fetcher: async () =>
      new Response(
        new ReadableStream(
          {
            pull(stream) {
              if (!sent) {
                sent = true;
                stream.enqueue(Buffer.from('{"servers":['));
                return;
              }
              controller.abort();
              stream.error(new Error('PRIVATE'));
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  const failed = await catalog.refresh();
  assert.equal(failed.failureCode, 'catalog-timeout');
  assert.equal(failed.failureStage, 'catalog-read');
  assert.deepEqual(failed.failureDiagnostics, {
    httpStatus: 200,
    pageBytes: 12,
    receivedBytes: 12,
    completedPages: 0,
    attempts: 1,
  });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
});

test('Registry distinguishes the shared refresh deadline from a network error', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const catalog = createRegistryCatalog({
    fetcher: async () => {
      controller.abort();
      throw new Error('PRIVATE');
    },
  });
  const failed = await catalog.refresh();
  assert.equal(failed.failureCode, 'catalog-timeout');
  assert.equal(failed.failureStage, 'catalog-fetch');
  assert.deepEqual(failed.failureDiagnostics, { pageBytes: 0, receivedBytes: 0, completedPages: 0, attempts: 1 });
});

test('Registry publishes atomic latest snapshots, removes absent listings and keeps stale last-good', async t => {
  let date = new Date('2026-10-02T00:00:00Z');
  let mode = 'initial';
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await httpFixture(t, async (req, res) => {
    if (mode === 'failure') {
      json(res, { error: 'unavailable' }, 503);
      return;
    }
    if (mode === 'initial') {
      if (!req.url.searchParams.has('cursor'))
        json(res, { servers: [record('org/alpha')], metadata: { nextCursor: 'second' } });
      else {
        entered.resolve();
        await release.promise;
        json(res, { servers: [record('org/beta')], metadata: {} });
      }
    } else if (mode === 'replacement')
      json(res, { servers: [record('org/alpha', { status: 'deleted' }), record('org/gamma')], metadata: {} });
    else json(res, { servers: [record('org/gamma', { status: 'deprecated' })], metadata: {} });
  });
  const catalog = createRegistryCatalog({ fetcher: f.fetcher, now: () => date });
  const first = catalog.refresh();
  await entered.promise;
  assert.deepEqual(catalog.snapshot().entries, []);
  const concurrent = catalog.refresh();
  release.resolve();
  await Promise.all([first, concurrent]);
  assert.equal(f.received.length, 2);
  assert.deepEqual(
    catalog.search('ORG').map(entry => entry.name),
    ['org/alpha', 'org/beta'],
  );
  const copy = catalog.snapshot();
  copy.entries[0].name = 'mutated';
  assert.equal(catalog.snapshot().entries[0].name, 'org/alpha');
  date = new Date('2026-10-02T06:00:01Z');
  mode = 'replacement';
  await catalog.refreshIfDue();
  assert.ok(
    f.received.every(
      request => request.url.searchParams.get('version') === 'latest' && !request.url.searchParams.has('updated_since'),
    ),
  );
  assert.deepEqual(
    catalog.snapshot().entries.map(entry => entry.name),
    ['org/gamma'],
  );
  mode = 'failure';
  const failed = await catalog.refresh();
  assert.equal(failed.stale, true);
  assert.equal(failed.refreshFailed, true);
  assert.equal(catalog.search('gamma').length, 1);
  assert.equal(failed.syncedAt, '2026-10-02T06:00:01.000Z');
  date = new Date('2026-10-03T00:00:01Z');
  mode = 'full';
  const resumed = await catalog.refreshIfDue();
  assert.equal(f.received.at(-1).url.searchParams.has('updated_since'), false);
  assert.deepEqual(
    catalog.snapshot().entries.map(entry => [entry.name, entry.status]),
    [['org/gamma', 'deprecated']],
  );
  assert.equal(resumed.refreshFailed, false);
  assert.equal(resumed.refreshInProgress, false);
  assert.equal(resumed.syncedAt, '2026-10-02T06:00:01.000Z');
  assert.equal(resumed.stale, true);
  const requests = f.received.length;
  const fresh = await catalog.refreshIfDue();
  assert.equal(f.received.length, requests + 1);
  assert.equal(fresh.syncedAt, '2026-10-03T00:00:01.000Z');
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.entries, resumed.entries);
});

test('Registry rejects cursor loops atomically, filters unsafe endpoints, marks unknown auth and resolves templates', async t => {
  let loop = false;
  const f = await httpFixture(t, (_req, res) =>
    json(res, {
      servers: [
        record('org/public'),
        record('org/private', { endpoint: 'http://127.0.0.1' }),
        record('org/template', {
          endpoint: 'https://{tenant}.example.test/tools',
          headers: [{ name: 'Authorization', isRequired: true, isSecret: true, value: 'do-not-copy' }],
        }),
      ],
      metadata: loop ? { nextCursor: 'loop' } : {},
    }),
  );
  const catalog = createRegistryCatalog({ fetcher: f.fetcher });
  await catalog.refresh();
  assert.deepEqual(
    catalog.snapshot().entries.map(entry => [entry.name, entry.authentication, entry.compatibility]),
    [
      ['org/public', 'unknown', 'unverified'],
      ['org/template', 'headers-required', 'template-required'],
    ],
  );
  const retained = catalog.search('template')[0];
  assert.deepEqual(Object.keys(retained).sort(), [
    'authentication',
    'compatibility',
    'description',
    'endpoint',
    'id',
    'name',
    'status',
    'title',
    'version',
  ]);
  assert.equal(JSON.stringify(retained).includes('do-not-copy'), false);
  loop = true;
  assert.equal((await catalog.refresh()).refreshFailed, true);
  assert.equal(catalog.snapshot().entries.length, 2);
  assert.equal(
    resolveRegistryEndpoint('https://{tenant}.example.test/tools', { tenant: 'acme' }),
    'https://acme.example.test/tools',
  );
  assert.throws(() => resolveRegistryEndpoint('https://{tenant}.example.test/tools', { tenant: 'private@evil' }), {
    code: 'endpoint-denied',
  });
  assert.throws(() => resolveRegistryEndpoint('https://{tenant}.example.test/tools', {}), { code: 'endpoint-denied' });
});

test('Registry resumes bounded latest-only chunks without publishing partial data', async () => {
  const requested = [];
  const catalog = createRegistryCatalog({
    fetcher: async input => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('version'), 'latest');
      assert.equal(url.searchParams.has('updated_since'), false);
      const page = Number(url.searchParams.get('cursor') ?? 0);
      requested.push(page);
      return Response.json({
        servers: [record(`org/latest-${page}`, { version: String(page) })],
        metadata: page < 60 ? { nextCursor: String(page + 1) } : {},
      });
    },
  });
  for (const pages of [25, 50]) {
    const partial = await catalog.refreshIfDue();
    assert.equal(partial.completedPages, pages);
    assert.equal(partial.refreshInProgress, true);
    assert.equal(partial.refreshFailed, false);
    assert.equal(partial.syncedAt, null);
    assert.deepEqual(partial.entries, []);
  }
  const complete = await catalog.refreshIfDue();
  assert.equal(complete.refreshInProgress, false);
  assert.equal(complete.entries.length, 61);
  assert.ok(complete.syncedAt);
  assert.deepEqual(
    requested,
    Array.from({ length: 61 }, (_, index) => index),
  );
});

test('Registry time slices resume a full latest snapshot even while the published snapshot is fresh', async () => {
  let elapsed = 0;
  let date = new Date('2026-10-02T00:00:00Z');
  let delta = false;
  const urls = [];
  const catalog = createRegistryCatalog({
    now: () => date,
    elapsedNow: () => elapsed,
    fetcher: async input => {
      const url = new URL(input);
      urls.push(url);
      elapsed += 45000;
      return Response.json(
        delta
          ? {
              servers: [
                record(url.searchParams.has('cursor') ? 'org/new' : 'org/old', {
                  status: url.searchParams.has('cursor') ? 'active' : 'deleted',
                }),
              ],
              metadata: url.searchParams.has('cursor') ? {} : { nextCursor: 'next' },
            }
          : { servers: [record('org/old')], metadata: {} },
      );
    },
  });
  await catalog.refresh();
  delta = true;
  date = new Date('2026-10-02T01:00:00Z');
  const partial = await catalog.refresh();
  assert.equal(partial.stale, false);
  assert.equal(partial.refreshInProgress, true);
  assert.deepEqual(
    partial.entries.map(entry => entry.name),
    ['org/old'],
  );
  date = new Date('2026-10-02T02:00:00Z');
  const complete = await catalog.refreshIfDue();
  assert.deepEqual(
    complete.entries.map(entry => entry.name),
    ['org/new'],
  );
  assert.equal(complete.syncedAt, '2026-10-02T01:00:00.000Z');
  assert.deepEqual(
    urls.slice(1).map(url => url.searchParams.get('updated_since')),
    [null, null],
  );
});

test('Registry retries only an unfinished page after timeout, HTTP and body failures', async t => {
  for (const failure of ['timeout', 'http', 'body'])
    await t.test(failure, async t => {
      let controller;
      t.mock.method(AbortSignal, 'timeout', () => {
        controller = new AbortController();
        return controller.signal;
      });
      let elapsed = 0;
      let mode = 'initial';
      let broken = true;
      const cursors = [];
      const catalog = createRegistryCatalog({
        elapsedNow: () => elapsed,
        fetcher: async input => {
          const cursor = new URL(input).searchParams.get('cursor');
          if (mode === 'initial') return Response.json({ servers: [record('org/old')], metadata: {} });
          cursors.push(cursor);
          elapsed += 45000;
          if (cursor && broken) {
            if (failure === 'timeout') {
              controller.abort();
              throw new Error('PRIVATE');
            }
            if (failure === 'http') return new Response('PRIVATE', { status: 503 });
            return new Response(
              new ReadableStream({
                start(stream) {
                  stream.enqueue(Buffer.from('{"servers":['));
                },
                pull(stream) {
                  stream.error(new Error('PRIVATE'));
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          return Response.json({
            servers: [record(cursor ? 'org/second' : 'org/first')],
            metadata: cursor ? {} : { nextCursor: 'second' },
          });
        },
      });
      const initial = await catalog.refresh();
      mode = 'full';
      await catalog.refresh();
      const failed = await catalog.refresh();
      assert.equal(
        failed.failureCode,
        { timeout: 'catalog-timeout', http: 'catalog-http', body: 'network-failed' }[failure],
      );
      assert.equal(failed.completedPages, 1);
      assert.deepEqual(failed.entries, initial.entries);
      assert.equal(failed.syncedAt, initial.syncedAt);
      broken = false;
      const recovered = await catalog.refresh();
      assert.deepEqual(cursors, [null, 'second', 'second']);
      assert.deepEqual(
        recovered.entries.map(entry => entry.name),
        ['org/first', 'org/second'],
      );
      assert.equal(recovered.failureCode, undefined);
    });
});

test('Registry rejects cursor loops and malformed later records across chunks without publishing staged edits', async () => {
  for (const failure of ['loop', 'timestamp']) {
    let elapsed = 0;
    let count = 0;
    const catalog = createRegistryCatalog({
      elapsedNow: () => elapsed,
      fetcher: async () => {
        elapsed += 45000;
        count++;
        const invalid = record('org/invalid');
        invalid._meta['io.modelcontextprotocol.registry/official'].updatedAt = 'PRIVATE';
        return Response.json({
          servers: count === 2 && failure === 'timestamp' ? [record('org/staged'), invalid] : [record('org/first')],
          metadata: { nextCursor: count === 2 && failure === 'timestamp' ? 'different' : 'repeat' },
        });
      },
    });
    assert.equal((await catalog.refresh()).completedPages, 1);
    const failed = await catalog.refresh();
    assert.equal(failed.failureCode, failure === 'loop' ? 'catalog-cursor-loop' : 'catalog-invalid-timestamp');
    assert.deepEqual(failed.entries, []);
    assert.equal(failed.refreshInProgress, false);
  }
});

test('Registry keeps the cumulative request budget across chunks and retries', async () => {
  let requests = 0;
  const catalog = createRegistryCatalog({
    fetcher: async () =>
      Response.json({
        servers: [],
        metadata: { nextCursor: String(++requests) },
      }),
  });
  let result;
  do {
    result = await catalog.refresh();
  } while (!result.refreshFailed);
  assert.equal(result.failureCode, 'catalog-page-limit');
  assert.equal(requests, 2000);
  assert.deepEqual(result.entries, []);

  requests = 0;
  const interrupted = createRegistryCatalog({
    fetcher: async () => {
      requests++;
      let sent = false;
      return new Response(
        new ReadableStream(
          {
            pull(stream) {
              if (sent) stream.error(new Error('PRIVATE'));
              else {
                sent = true;
                stream.enqueue(Buffer.from('{"servers":['));
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  do {
    result = await interrupted.refresh();
    assert.ok(requests <= 2000);
  } while (result.failureCode !== 'catalog-page-limit');
  assert.equal(requests, 2000);
  assert.equal(result.failureStage, 'catalog-page');
  assert.equal(result.failureDiagnostics.receivedBytes, 24000);
  assert.deepEqual(result.entries, []);
});

test('Registry completes a bounded 1500-page latest catalog without exposing partial data', async () => {
  let pages = 0;
  const catalog = createRegistryCatalog({
    fetcher: async () => {
      pages++;
      return Response.json({
        servers: [record(`org/latest-${pages}`, { version: String(pages) })],
        metadata: pages < 1500 ? { nextCursor: String(pages) } : {},
      });
    },
  });
  let result = await catalog.refresh();
  while (result.refreshInProgress) {
    assert.equal(result.refreshFailed, false);
    assert.deepEqual(result.entries, []);
    assert.equal(result.syncedAt, null);
    result = await catalog.refreshIfDue();
  }
  assert.equal(pages, 1500);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.entries.length, 1500);
  assert.equal(result.entries[0].version, '1');
  assert.equal(result.entries.at(-1).version, '1500');
  assert.ok(result.syncedAt);
});

test('Registry drops unused raw metadata while atomically retaining bounded latest listings', async () => {
  let scanning = false;
  let pages = 0;
  let receivedBytes = 0;
  const catalog = createRegistryCatalog({
    fetcher: async () => {
      if (!scanning) return Response.json({ servers: [record('org/last-good')], metadata: {} });
      pages++;
      const item = record(`org/latest-${pages}`, {
        version: String(pages),
        headers: [{ name: 'Authorization', isRequired: true, value: 'private-header-value' }],
      });
      item.server.remotes[0].variables = { unused: 'x'.repeat(1700000) };
      const body = JSON.stringify({ servers: [item], metadata: pages < 40 ? { nextCursor: String(pages) } : {} });
      receivedBytes += Buffer.byteLength(body);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  });
  const initial = await catalog.refresh();
  scanning = true;
  const partial = await catalog.refresh();
  assert.equal(partial.completedPages, 25);
  assert.equal(partial.refreshFailed, false);
  assert.deepEqual(partial.entries, initial.entries);
  assert.equal(partial.syncedAt, initial.syncedAt);
  const complete = await catalog.refreshIfDue();
  assert.ok(receivedBytes > 64 * 1024 * 1024);
  assert.equal(pages, 40);
  assert.equal(complete.refreshFailed, false);
  assert.equal(complete.refreshInProgress, false);
  assert.equal(complete.entries.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(complete.entries)) < 32768);
  assert.equal(JSON.stringify(complete.entries).includes('private-header-value'), false);
  assert.ok(
    complete.entries.every(
      entry => entry.authentication === 'headers-required' && !('variables' in entry) && !('headers' in entry),
    ),
  );
  assert.deepEqual(
    complete.entries.map(entry => entry.version),
    Array.from({ length: 40 }, (_, index) => String(index + 1)),
  );
});

test('Registry rejects oversized pages and normalized state without replacing the last-good snapshot', async t => {
  for (const mode of ['page', 'state', 'entries', 'names'])
    await t.test(mode, async () => {
      let scanning = false;
      let pages = 0;
      const catalog = createRegistryCatalog({
        fetcher: async () => {
          if (!scanning) return Response.json({ servers: [record('org/last-good')], metadata: {} });
          pages++;
          if (mode === 'page')
            return new Response('x'.repeat(2097153), { headers: { 'content-type': 'application/json' } });
          const servers = Array.from({ length: 100 }, (_, index) => {
            const item = record(`org/bounded-${pages}-${index}`);
            if (mode === 'state') item.server.description = 'x'.repeat(16000);
            else
              item.server.remotes =
                mode === 'names'
                  ? []
                  : Array.from({ length: 64 }, () => ({
                      type: 'streamable-http',
                      url: 'https://mcp.example.test/tools',
                    }));
            return item;
          });
          return Response.json({ servers, metadata: { nextCursor: String(pages) } });
        },
      });
      const initial = await catalog.refresh();
      scanning = true;
      let result = await catalog.refresh();
      while (!result.refreshFailed) {
        assert.ok(pages < (mode === 'names' ? 1002 : 50));
        assert.deepEqual(result.entries, initial.entries);
        result = await catalog.refreshIfDue();
      }
      assert.equal(
        result.failureCode,
        ['entries', 'names'].includes(mode) ? 'catalog-entry-limit' : 'catalog-byte-limit',
      );
      assert.equal(result.failureStage, mode === 'page' ? 'catalog-read' : 'catalog-page');
      assert.equal(result.refreshInProgress, false);
      assert.deepEqual(result.entries, initial.entries);
      assert.equal(result.syncedAt, initial.syncedAt);
    });
});

test('Registry accounts for repeated latest records and deletions across bounded chunks', async () => {
  let date = new Date('2026-10-14T00:00:00Z');
  let updating = false;
  let pages = 0;
  let receivedBytes = 0;
  const records = Array.from({ length: 64 }, (_, index) => {
    const item = record(`org/replaced-${index}`);
    item.server.description = 'x'.repeat(16000);
    return item;
  });
  const catalog = createRegistryCatalog({
    now: () => date,
    fetcher: async () => {
      if (!updating) return Response.json({ servers: records, metadata: {} });
      pages++;
      const servers =
        pages === 70
          ? records.slice(0, 32).map(item => ({
              ...item,
              _meta: {
                'io.modelcontextprotocol.registry/official': {
                  status: 'deleted',
                  updatedAt: date.toISOString(),
                  isLatest: true,
                },
              },
            }))
          : records;
      const body = JSON.stringify({ servers, metadata: pages < 70 ? { nextCursor: String(pages) } : {} });
      receivedBytes += Buffer.byteLength(body);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  });
  const initial = await catalog.refresh();
  updating = true;
  date = new Date('2026-10-14T01:00:00Z');
  let result = await catalog.refresh();
  while (result.refreshInProgress) {
    assert.equal(result.refreshFailed, false);
    assert.deepEqual(result.entries, initial.entries);
    result = await catalog.refreshIfDue();
  }
  assert.ok(receivedBytes > 64 * 1024 * 1024);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.entries.length, 32);
  assert.deepEqual(
    result.entries.map(entry => entry.name),
    records.slice(32).map(item => item.server.name),
  );
  assert.equal(result.syncedAt, date.toISOString());
});

test('Registry deduplicates in-flight latest refreshes', async () => {
  let delta = false;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const queries = [];
  const catalog = createRegistryCatalog({
    fetcher: async input => {
      const url = new URL(input);
      queries.push(url);
      if (delta) {
        entered.resolve();
        await release.promise;
      }
      return Response.json({ servers: [record(delta ? 'org/new' : 'org/old')], metadata: {} });
    },
  });
  await catalog.refresh();
  delta = true;
  const pending = catalog.refresh();
  await entered.promise;
  assert.equal(catalog.refresh(), pending);
  release.resolve();
  const complete = await pending;
  assert.equal(complete.refreshInProgress, false);
  assert.equal(queries.length, 2);
  assert.equal(queries.at(-1).searchParams.has('updated_since'), false);
  assert.deepEqual(
    complete.entries.map(entry => entry.name),
    ['org/new'],
  );
});

test('Registry follows official promotion with old timestamps and never falls back to historical remotes', async () => {
  let latest = record('org/promoted', { version: 'arbitrary-new-label' });
  let extra = [record('org/deleted')];
  const catalog = createRegistryCatalog({
    fetcher: async input => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('version'), 'latest');
      assert.equal(url.searchParams.has('updated_since'), false);
      return Response.json({ servers: [latest, ...extra], metadata: {} });
    },
  });
  await catalog.refresh();
  latest = record('org/promoted', { version: 'older-official-label', status: 'deprecated' });
  latest.server.remotes.push({ type: 'streamable-http', url: 'https://second.example.test/mcp' });
  extra = [record('org/deleted', { status: 'deleted' })];
  const promoted = await catalog.refresh();
  assert.deepEqual(
    promoted.entries.map(entry => [entry.id, entry.status]),
    [
      ['org/promoted@older-official-label:0', 'deprecated'],
      ['org/promoted@older-official-label:1', 'deprecated'],
    ],
  );
  for (const remotes of [
    [],
    [{ type: 'sse', url: 'https://example.test/mcp' }],
    [{ type: 'streamable-http', url: 'http://127.0.0.1/mcp' }],
  ]) {
    latest = record('org/promoted', { version: 'package-only-latest' });
    latest.server.remotes = remotes;
    assert.deepEqual((await catalog.refresh()).entries, []);
  }
});

test('Registry rejects conflicting latest versions across pages, including unusable records, atomically', async () => {
  for (const usable of [true, false]) {
    let scanning = false;
    let elapsed = 0;
    const catalog = createRegistryCatalog({
      elapsedNow: () => elapsed,
      fetcher: async input => {
        if (!scanning) return Response.json({ servers: [record('org/last-good')], metadata: {} });
        elapsed += 45000;
        const last = new URL(input).searchParams.has('cursor');
        const item = record('org/changing', { version: last ? 'other-latest-label' : 'first-latest-label' });
        if (!last && !usable) item.server.remotes = [];
        return Response.json({ servers: [item], metadata: last ? {} : { nextCursor: 'last' } });
      },
    });
    const initial = await catalog.refresh();
    scanning = true;
    assert.equal((await catalog.refresh()).refreshInProgress, true);
    const failed = await catalog.refresh();
    assert.equal(failed.failureCode, 'catalog-invalid-schema');
    assert.equal(failed.refreshInProgress, false);
    assert.deepEqual(failed.entries, initial.entries);
    assert.equal(failed.syncedAt, initial.syncedAt);
  }
});

test('Registry rejects non-latest metadata and malformed publication timestamps without replacing last-good', async () => {
  let item = record('org/latest');
  const catalog = createRegistryCatalog({ fetcher: async () => Response.json({ servers: [item], metadata: {} }) });
  const initial = await catalog.refresh();
  item = record('org/not-latest');
  item._meta['io.modelcontextprotocol.registry/official'].isLatest = false;
  assert.equal((await catalog.refresh()).failureCode, 'catalog-invalid-schema');
  assert.deepEqual(catalog.snapshot().entries, initial.entries);
  item = record('org/latest');
  item._meta['io.modelcontextprotocol.registry/official'].publishedAt = 'invalid';
  assert.equal((await catalog.refresh()).failureCode, 'catalog-invalid-timestamp');
  assert.deepEqual(catalog.snapshot().entries, initial.entries);
});

test('Registry replaces all endpoints when the same latest record repeats across pages', async () => {
  const catalog = createRegistryCatalog({
    fetcher: async input => {
      const last = new URL(input).searchParams.has('cursor');
      const item = record('org/latest');
      if (!last) item.server.remotes.push({ type: 'streamable-http', url: 'https://removed.example.test/mcp' });
      return Response.json({ servers: [item], metadata: last ? {} : { nextCursor: 'last' } });
    },
  });
  const complete = await catalog.refresh();
  assert.equal(complete.refreshFailed, false);
  assert.deepEqual(
    complete.entries.map(entry => entry.id),
    ['org/latest@1:0'],
  );
});
