import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { authConfig } from '../src/auth.ts';
import { registerGoogleOperations } from '../src/google-operations.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';

test('real HTTP file transport returns bounded bytes under the owner session and fences delivery', async () => {
  const f = await googleFixture();
  const app = Fastify(securityServerOptions());
  const origin = authConfig().webOrigin;
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x71);
  const metadata = { id: 'file-1', name: 'Report', mimeType: 'application/pdf' };
  let mode = 'normal';
  let sessionActive = true;
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let disconnected = Promise.withResolvers();
  const provider = createServer(async (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, 'Bearer initial-private-access');
    const url = new URL(request.url, 'http://fixture');
    response.setHeader('content-type', 'application/json');
    if (url.searchParams.has('fields')) {
      response.end(
        JSON.stringify(url.pathname.endsWith('/file-1') ? metadata : { files: [metadata], nextPageToken: 'next' }),
      );
    } else if (mode === 'oversize') {
      for (let index = 0; index < 11; index++) response.write(Buffer.alloc(1024 * 1024, 0x61));
      response.end();
    } else if (mode === 'denied') {
      response.writeHead(403);
      response.end(JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }));
    } else if (mode === 'wait') {
      response.once('close', () => disconnected.resolve());
      entered.resolve();
      await release.promise;
      if (!response.destroyed) response.end(payload);
    } else {
      if (mode === 'session-revoked') sessionActive = false;
      response.setHeader('content-type', 'application/pdf');
      response.end(payload);
    }
  });
  try {
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const connected = await f.connect();
    const expectedIntegration = {
      integrationId: connected.integrationId,
      accountId: connected.accountId,
      generation: connected.generation,
    };
    const content = { fileId: 'file-1', expectedIntegration, kind: 'download' };
    const auth = {
      api: {
        getSession: async ({ headers }) => {
          const userId =
            headers.get('cookie') === 'session=owner' && sessionActive
              ? f.member.userId
              : headers.get('cookie') === 'session=admin'
                ? f.admin.userId
                : null;
          return userId ? { user: { id: userId }, session: { id: 'fixture-session' } } : null;
        },
      },
    };
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: createGoogleWorkspaceService(f.serviceOptions),
      fetcher: (url, init) => {
        assert.equal(url.origin, 'https://www.googleapis.com');
        return fetch(`http://127.0.0.1:${provider.address().port}${url.pathname}${url.search}`, init);
      },
    });
    registerSecurity(app, origin);
    await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Files', version: '1' } } });
    await app.register(
      async routes =>
        registerGoogleOperations(routes, {
          auth,
          runtime: f.runtime,
          operations,
          approve: createGoogleApproval({
            runtime: f.runtime,
            resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
          }),
        }),
      { prefix: '/v1' },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `${app.listeningOrigin}/v1/workspaces/${f.workspace.id}/google-workspace/operations`;
    const send = (path, body, headers = {}, signal) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { origin, cookie: 'session=owner', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    for (const [path, body] of [
      ['/files/list', { expectedIntegration }],
      ['/files/metadata', { fileId: 'file-1', expectedIntegration }],
      ['/files/content', content],
    ]) {
      assert.equal((await send(path, body, { cookie: '' })).status, 401);
      assert.equal((await send(path, body, { origin: 'https://evil.test' })).status, 403);
      assert.deepEqual(await (await send(path, body, { cookie: 'session=admin' })).json(), {
        error: 'integration-required',
      });
      assert.equal((await send(path, { ...body, url: 'https://evil.test' })).status, 400);
    }
    assert.deepEqual(await (await send('/files/list', { expectedIntegration })).json(), {
      files: [metadata],
      nextPageToken: 'next',
      incompleteSearch: false,
      skipped: 0,
    });
    assert.deepEqual(await (await send('/files/metadata', { fileId: 'file-1', expectedIntegration })).json(), metadata);
    const response = await send('/files/content', content);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('content-length'), String(payload.length));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    mode = 'oversize';
    assert.deepEqual(await (await send('/files/content', content)).json(), { error: 'response-too-large' });
    mode = 'denied';
    assert.deepEqual(await (await send('/files/content', content)).json(), { error: 'source-access-denied' });
    mode = 'session-revoked';
    assert.deepEqual(await (await send('/files/content', content)).json(), { error: 'operation-not-found' });
    sessionActive = true;
    mode = 'wait';
    const controller = new AbortController();
    const cancelled = send('/files/content', content, {}, controller.signal);
    const cancellation = assert.rejects(cancelled, error => error.name === 'AbortError');
    await entered.promise;
    controller.abort();
    await cancellation;
    await disconnected.promise;
    release.resolve();
    entered = Promise.withResolvers();
    release = Promise.withResolvers();
    disconnected = Promise.withResolvers();
    const stale = send('/files/content', content);
    await entered.promise;
    await f.service.disconnect(f.workspace.id, f.member.userId);
    release.resolve();
    assert.deepEqual(await (await stale).json(), { error: 'stale-integration' });
    assert.equal(JSON.stringify(app.swagger()).includes('readGoogleFileContentV1'), true);
  } finally {
    release.resolve();
    await app.close();
    await new Promise(resolve => provider.close(resolve));
    await f.close();
  }
});
