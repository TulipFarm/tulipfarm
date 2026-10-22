import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { authConfig } from '../src/auth.ts';
import { mcpCallbackSchema, McpHttpError, workspaceMcpHttp } from '../src/workspace-mcp-http.ts';

test('workspace MCP HTTP boundary authenticates before parsing and conceals diagnostics', async () => {
  const logs = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write: value => logs.push(value) } } });
  let commands = 0;
  let failure;
  await app.register(async routes => {
    const boundary = workspaceMcpHttp(
      routes,
      {
        api: {
          getSession: async ({ headers }) =>
            headers.get('cookie') === 'session=valid' ? { user: { id: 'user' }, session: { id: 'login' } } : null,
        },
      },
      () => null,
    );
    routes.post(
      '/command',
      {
        logLevel: 'silent',
        bodyLimit: 1024,
        schema: boundary.schema(
          'testMcpCommand',
          z.strictObject({ saved: z.literal(true) }),
          undefined,
          z.strictObject({ digest: z.string().length(64) }),
        ),
      },
      request => {
        assert.deepEqual(boundary.session(request), { userId: 'user', sessionId: 'login' });
        commands++;
        if (failure) throw failure;
        return { saved: true };
      },
    );
    routes.get(
      '/callback',
      {
        logLevel: 'silent',
        schema: boundary.schema(
          'testMcpCallback',
          z.strictObject({ saved: z.literal(true) }),
          undefined,
          undefined,
          mcpCallbackSchema,
        ),
      },
      () => ({ saved: true }),
    );
  });
  const headers = { origin: authConfig().webOrigin, cookie: 'session=valid' };
  const request = async (options, status, expected) => {
    const response = await app.inject({ headers, ...options });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.deepEqual(response.json(), expected);
  };
  try {
    await request(
      { method: 'POST', url: '/command', headers: { origin: headers.origin }, payload: { digest: 'bad' } },
      401,
      { error: 'sign-in-required' },
    );
    await request(
      {
        method: 'POST',
        url: '/command',
        headers: { cookie: headers.cookie, origin: 'https://other.example' },
        payload: { digest: 'a'.repeat(64) },
      },
      403,
      { error: 'untrusted-origin' },
    );
    for (const payload of [
      { digest: 'short' },
      { digest: 'a'.repeat(64), arguments: {} },
      { digest: ['a'.repeat(64)] },
    ])
      await request({ method: 'POST', url: '/command', payload }, 400, { error: 'invalid-request' });
    assert.equal(commands, 0);
    await request({ method: 'POST', url: '/command', payload: { digest: 'a'.repeat(64) } }, 200, { saved: true });
    for (const [error, status, code] of [
      [new AccessDenied(), 404, 'mcp-not-found'],
      [new McpHttpError('mcp-conflict', 409), 409, 'mcp-conflict'],
      [new Error('private-provider-secret'), 503, 'mcp-unavailable'],
    ]) {
      failure = error;
      await request({ method: 'POST', url: '/command', payload: { digest: 'a'.repeat(64) } }, status, { error: code });
    }
    await request(
      { method: 'POST', url: '/command', payload: { digest: 'private-provider-secret'.repeat(100) } },
      413,
      { error: 'request-too-large' },
    );
    await request(
      {
        method: 'POST',
        url: '/command',
        headers: { ...headers, 'content-type': 'application/xml' },
        payload: '<secret/>',
      },
      415,
      { error: 'unsupported-media-type' },
    );
    const state = 'private-state-'.repeat(4);
    await request({ url: `/callback?state=${state}&code=private-oauth-code` }, 200, { saved: true });
    for (const query of [
      `state=${state}&code=one&code=two`,
      `state=${state}&code=one&error=denied`,
      `state=${state}&code=one&redirect_uri=https://other.example`,
    ])
      await request({ url: `/callback?${query}` }, 400, { error: 'invalid-request' });
    app.log.info('mcp-log-probe');
    assert.ok(logs.join('').includes('mcp-log-probe'));
    for (const secret of [state, 'private-oauth-code', 'private-provider-secret'])
      assert.equal(logs.join('').includes(secret), false);
  } finally {
    await app.close();
  }
});
