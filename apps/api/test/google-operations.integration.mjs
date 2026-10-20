import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { googleRuntimeFixture } from '../../../packages/agents/test/google-fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerGoogleOperations } from '../src/google-operations.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';

test('Google HTTP caller separates authenticated owner approval and never accepts model authority', async () => {
  const f = await googleRuntimeFixture();
  const app = Fastify(securityServerOptions());
  const origin = authConfig().webOrigin;
  const auth = {
    api: {
      getSession: async ({ headers }) => {
        const userId =
          headers.get('cookie') === 'session=owner'
            ? f.member.userId
            : headers.get('cookie') === 'session=admin'
              ? f.admin.userId
              : null;
        return userId ? { user: { id: userId }, session: { id: 'synthetic' } } : null;
      },
    },
  };
  try {
    registerSecurity(app, origin);
    await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Google', version: '1' } } });
    await app.register(
      async routes =>
        registerGoogleOperations(routes, {
          auth,
          runtime: f.runtime,
          operations: f.factory(f.runtime),
          approve: f.approve,
        }),
      { prefix: '/v1' },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `${app.listeningOrigin}/v1/workspaces/${f.workspace.id}/google-workspace/operations`;
    async function request(path, method = 'GET', body, expected = 200, headers = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          origin,
          cookie: 'session=owner',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      return value;
    }
    const write = { commandId: randomUUID(), operation: { kind: 'docs.documents.create', title: 'Owner approved' } };
    const dummy = randomUUID();
    for (const [path, method, body] of [
      ['/catalog', 'GET'],
      ['/proposals', 'GET'],
      ['/read', 'POST', { operation: { kind: 'docs.documents.get', documentId: 'private-doc' } }],
      ['/proposals', 'POST', write],
      [`/proposals/${dummy}`, 'GET'],
      [`/proposals/${dummy}/decision`, 'POST', { digest: 'a'.repeat(64), decision: 'approve' }],
      [`/proposals/${dummy}/execute`, 'POST'],
    ]) {
      await request(path, method, body, 401, { cookie: '' });
      if (method === 'POST') await request(path, method, body, 403, { origin: 'https://foreign.test' });
    }
    const catalog = await request('/catalog');
    assert.equal(catalog.operations.find(operation => operation.kind === 'docs.documents.create').effect, 'write');
    assert.equal(
      (await request('/read', 'POST', { operation: { kind: 'docs.documents.get', documentId: 'private-doc' } })).data
        .title,
      'Private document',
    );
    const proposal = await request('/proposals', 'POST', write);
    const path = `/proposals/${proposal.id}`;
    await request(`${path}/execute`, 'POST', undefined, 409);
    await request(`${path}/decision`, 'POST', { digest: proposal.digest, decision: 'approve' }, 404, {
      cookie: 'session=admin',
    });
    await request(`${path}/decision`, 'POST', { digest: 'b'.repeat(64), decision: 'approve' }, 409);
    await request(
      `${path}/decision`,
      'POST',
      { digest: proposal.digest, decision: 'approve', operation: write.operation },
      400,
    );
    assert.equal(
      (await request(`${path}/decision`, 'POST', { digest: proposal.digest, decision: 'approve' })).decision,
      'approve',
    );
    assert.equal((await request(`${path}/execute`, 'POST')).status, 'succeeded');
    assert.equal((await request(path)).receipt.status, 'succeeded');
    assert.equal((await request(`${path}/execute`, 'POST')).status, 'succeeded');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    await request(`${path}/execute`, 'POST', { userId: f.member.userId }, 400);
    await request(
      '/read',
      'POST',
      { operation: { kind: 'docs.documents.get', documentId: 'private-doc', url: 'https://evil.test' } },
      400,
    );
    await request('/proposals', 'POST', { ...write, token: 'synthetic-forgery' }, 400);
    const upload = await request('/proposals', 'POST', {
      commandId: randomUUID(),
      operation: {
        kind: 'drive.files.upload',
        mimeType: 'text/plain',
        contentBase64: Buffer.alloc(1_048_576, 'a').toString('base64'),
      },
    });
    assert.equal(upload.operation.contentBase64.length, 1_398_104);
    const page = await request('/proposals?limit=1');
    assert.equal(page.proposals.length, 1);
    assert.equal(page.proposals[0].id, upload.id);
    assert.deepEqual(Object.keys(page.proposals[0]).sort(), [
      'createdAt',
      'decision',
      'expiresAt',
      'id',
      'operationKind',
      'receiptStatus',
    ]);
    assert.equal(page.proposals[0].operationKind, 'drive.files.upload');
    assert.equal(page.proposals[0].receiptStatus, null);
    const final = await request(`/proposals?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
    assert.equal(final.nextCursor, null);
    assert.equal(final.proposals[0].id, proposal.id);
    assert.equal(final.proposals[0].decision, 'approve');
    assert.equal(final.proposals[0].receiptStatus, 'succeeded');
    assert.deepEqual(await request('/proposals', 'GET', undefined, 200, { cookie: 'session=admin' }), {
      proposals: [],
      nextCursor: null,
    });
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=bad',
      'cursor=invalid',
      `userId=${f.member.userId}`,
      'limit=1&limit=2',
    ]) {
      await request(`/proposals?${query}`, 'GET', undefined, 400);
    }
    const exact = await request(path);
    assert.deepEqual(exact.operation, write.operation);
    assert.equal(exact.digest, proposal.digest);
    assert.equal(exact.receipt.result.untrusted, true);
    const oversized = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${f.workspace.id}/google-workspace/operations/proposals`,
      headers: { origin, cookie: 'session=owner' },
      payload: { ...write, padding: 'x'.repeat(2_101_248) },
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(JSON.stringify(app.swagger()).includes('decideGoogleProposalV1'), true);
    assert.equal(JSON.stringify(app.swagger()).includes('listGoogleProposalsV1'), true);
  } finally {
    await app.close();
    await f.close();
  }
});
