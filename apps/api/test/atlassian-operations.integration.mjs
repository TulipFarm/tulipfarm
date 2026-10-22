import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import {
  operationFixture,
  boardId,
  listId,
  cardId,
  cloudId,
  toolNames,
} from '../../../packages/atlassian/test/operation-fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerAtlassianOperations } from '../src/atlassian-operations.ts';

test('operation HTTP contracts authenticate exact approval separately from runtime execution', async t => {
  const f = await operationFixture();
  const app = Fastify();
  const origin = authConfig().webOrigin;
  const headers = { origin, cookie: 'session=member' };
  const sessions = new Map([
    ['session=member', f.member.userId],
    ['session=admin', f.one.userId],
    ['session=outsider', randomUUID()],
  ]);
  const auth = {
    api: {
      getSession: async ({ headers }) => {
        const id = sessions.get(headers.get('cookie'));
        return id ? { user: { id }, session: { id: 'session' } } : null;
      },
    },
  };
  const base = `/v1/workspaces/${f.one.id}/atlassian`;
  const request = async (options, status) => {
    const result = await app.inject({ headers, ...options });
    assert.equal(result.statusCode, status, result.body);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    return result.json();
  };
  try {
    await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Operations', version: '1' } } });
    await app.register(async routes => registerAtlassianOperations(routes, auth, f.operations, f.approve), {
      prefix: '/v1',
    });
    await app.ready();
    const write = {
      commandId: randomUUID(),
      sourceId: f.source.id,
      operation: { kind: 'card.create', listId, name: 'Exact title', desc: 'Exact description' },
    };
    await t.test('every route authenticates and all unsafe methods require same origin', async () => {
      const root = `${base}/operations/proposals/${randomUUID()}`;
      const routes = [
        { url: `${base}/sources` },
        {
          method: 'POST',
          url: `${base}/sources`,
          payload: { accountId: f.accountId, name: 'Board', binding: { kind: 'trello', boardId } },
        },
        { method: 'POST', url: `${base}/sources/${f.source.id}/disable` },
        { method: 'POST', url: `${base}/sources/${f.source.id}/qualify` },
        {
          method: 'POST',
          url: `${base}/operations/read`,
          payload: { sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
        },
        { method: 'POST', url: `${base}/operations/proposals`, payload: write },
        { url: root },
        { method: 'POST', url: `${root}/decision`, payload: { digest: 'a'.repeat(64), decision: 'approve' } },
        { method: 'POST', url: `${root}/execute` },
      ];
      for (const route of routes) {
        assert.deepEqual(await request({ ...route, headers: { origin } }, 401), { error: 'sign-in-required' });
        if (route.method === 'POST')
          assert.deepEqual(
            await request({ ...route, headers: { cookie: headers.cookie, origin: 'https://foreign.test' } }, 403),
            { error: 'untrusted-origin' },
          );
      }
    });
    let proposal;
    await t.test('read succeeds without approval; proposed writes require exact authenticated decision', async () => {
      const read = await request(
        {
          method: 'POST',
          url: `${base}/operations/read`,
          payload: { sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
        },
        200,
      );
      assert.equal(read.untrusted, true);
      assert.equal(read.data.card.id, cardId);
      proposal = await request({ method: 'POST', url: `${base}/operations/proposals`, payload: write }, 200);
      assert.deepEqual(proposal.operation, write.operation);
      assert.equal(proposal.decision, null);
      const root = `${base}/operations/proposals/${proposal.id}`;
      await request({ method: 'POST', url: `${root}/execute` }, 409);
      await request(
        { method: 'POST', url: `${root}/decision`, payload: { digest: 'b'.repeat(64), decision: 'approve' } },
        409,
      );
      await request(
        {
          method: 'POST',
          url: `${root}/decision`,
          headers: { origin, cookie: 'session=admin' },
          payload: { digest: proposal.digest, decision: 'approve' },
        },
        404,
      );
      await request(
        {
          method: 'POST',
          url: `${root}/decision`,
          payload: { digest: proposal.digest, decision: 'approve', operation: { kind: 'card.delete', cardId } },
        },
        400,
      );
      const decision = await request(
        { method: 'POST', url: `${root}/decision`, payload: { digest: proposal.digest, decision: 'approve' } },
        200,
      );
      assert.equal(decision.decision, 'approve');
      await request(
        { method: 'POST', url: `${root}/execute`, payload: { operation: { kind: 'card.delete', cardId } } },
        400,
      );
      const result = await request({ method: 'POST', url: `${root}/execute` }, 200);
      assert.equal(result.status, 'succeeded');
      const count = f.providerCalls.length;
      assert.deepEqual(await request({ method: 'POST', url: `${root}/execute` }, 200), result);
      assert.equal(f.providerCalls.length, count);
      assert.equal((await request({ url: root }, 200)).receipt.status, 'succeeded');
    });
    await t.test('input contracts reject arbitrary dispatch, credentials, source overrides, and coercion', async () => {
      for (const operation of [
        { kind: 'rest', method: 'DELETE', url: 'https://evil.test' },
        { kind: 'card.read', cardId, token: 'private' },
        { kind: 'card.search', query: 'hello', page: '1' },
        { kind: 'card.create', listId, name: 'Exact', boardId: 'f'.repeat(24) },
      ])
        await request(
          { method: 'POST', url: `${base}/operations/read`, payload: { sourceId: f.source.id, operation } },
          400,
        );
      await request(
        {
          method: 'POST',
          url: `${base}/operations/read`,
          payload: { sourceId: f.source.id, operation: write.operation },
        },
        409,
      );
      await request(
        {
          method: 'POST',
          url: `${base}/operations/proposals`,
          payload: { ...write, operation: { kind: 'card.read', cardId } },
        },
        409,
      );
      await request(
        {
          method: 'POST',
          url: `${base}/operations/proposals`,
          payload: { ...write, operation: { ...write.operation, desc: 'x'.repeat(140000) } },
        },
        413,
      );
      await request(
        {
          method: 'POST',
          url: `${base}/operations/read`,
          payload: { sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
          headers: { origin, cookie: 'session=outsider' },
        },
        404,
      );
    });
    await t.test(
      'MCP encoded credential keys reject HTTP reads and qualification and sanitize approved write receipts',
      async () => {
        const token = 'synthetic-access-token';
        const encoded = Buffer.from(token).toString('base64');
        const accountId = await f.connect('atlassian-mcp');
        const source = await request(
          {
            method: 'POST',
            url: `${base}/sources`,
            payload: { name: 'Jira', accountId, binding: { kind: 'jira', cloudId } },
          },
          200,
        );
        try {
          for (const nested of [{ [encoded]: 'innocent value' }, [[{ [encoded]: 'innocent value' }]]]) {
            f.setProvider(async (_url, init) => {
              const rpc = JSON.parse(init.body);
              if (rpc.method === 'tools/call')
                return Response.json({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: { content: [], structuredContent: { nested } },
                });
            });
            assert.deepEqual(
              await request(
                {
                  method: 'POST',
                  url: `${base}/operations/read`,
                  payload: { sourceId: source.id, operation: { kind: 'jira.read', issueIdOrKey: 'OPS-1' } },
                },
                503,
              ),
              { error: 'account-unavailable' },
            );
            const proposed = await request(
              {
                method: 'POST',
                url: `${base}/operations/proposals`,
                payload: {
                  commandId: randomUUID(),
                  sourceId: source.id,
                  operation: { kind: 'jira.create', projectKey: 'OPS', issueTypeName: 'Task', summary: 'Exact' },
                },
              },
              200,
            );
            const root = `${base}/operations/proposals/${proposed.id}`;
            assert.equal(
              (
                await request(
                  {
                    method: 'POST',
                    url: `${root}/decision`,
                    payload: { digest: proposed.digest, decision: 'approve' },
                  },
                  200,
                )
              ).decision,
              'approve',
            );
            const expected = { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' };
            assert.deepEqual(await request({ method: 'POST', url: `${root}/execute` }, 200), expected);
            assert.deepEqual((await request({ url: root }, 200)).receipt, expected);
            assert.deepEqual(
              (
                await f.db.platform.query(
                  `SELECT status,result,error FROM ${f.table('tf_atlassian_receipts')} WHERE proposal_id=$1`,
                  [proposed.id],
                )
              ).rows,
              [expected],
            );
            const count = f.providerCalls.length;
            assert.deepEqual(await request({ method: 'POST', url: `${root}/execute` }, 200), expected);
            assert.equal(f.providerCalls.length, count);
            f.setProvider(async (_url, init) => {
              const rpc = JSON.parse(init.body);
              if (rpc.method === 'tools/list')
                return Response.json({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    tools: [
                      {
                        name: toolNames['jira.read'],
                        inputSchema: { type: 'object', properties: { issue: { type: 'object', examples: [nested] } } },
                      },
                    ],
                  },
                });
            });
            assert.deepEqual(await request({ method: 'POST', url: `${base}/sources/${source.id}/qualify` }, 503), {
              error: 'account-unavailable',
            });
          }
          for (const name of [
            'tf_atlassian_sources',
            'tf_atlassian_proposals',
            'tf_atlassian_decisions',
            'tf_atlassian_receipts',
          ]) {
            const stored = JSON.stringify((await f.db.platform.query(`SELECT * FROM ${f.table(name)}`)).rows);
            assert.equal(stored.includes(encoded), false, name);
            assert.equal(stored.includes(token), false, name);
          }
        } finally {
          f.setProvider(undefined);
        }
        assert.equal(
          (await request({ method: 'POST', url: `${base}/sources/${source.id}/qualify` }, 200)).data.catalog.length,
          9,
        );
      },
    );
    await t.test(
      'disabled approval composition cannot mint decisions and Swagger lists strict operations',
      async () => {
        const disabled = Fastify();
        try {
          registerAtlassianOperations(disabled, auth, f.operations, null);
          const response = await disabled.inject({
            method: 'POST',
            url: `/workspaces/${f.one.id}/atlassian/operations/proposals/${proposal.id}/decision`,
            headers,
            payload: { digest: proposal.digest, decision: 'approve' },
          });
          assert.equal(response.statusCode, 503);
        } finally {
          await disabled.close();
        }
        const spec = app.swagger();
        assert.equal(Object.keys(spec.paths).length, 8);
        const route =
          spec.paths['/v1/workspaces/{workspaceId}/atlassian/operations/proposals/{proposalId}/decision'].post;
        assert.equal(route.requestBody.content['application/json'].schema.additionalProperties, false);
        assert.deepEqual(route.requestBody.content['application/json'].schema.required, ['digest', 'decision']);
        assert.equal(
          JSON.stringify(await f.operations.proposal(f.one.id, f.member.userId, proposal.id)).includes(
            'synthetic-access-token',
          ),
          false,
        );
      },
    );
  } finally {
    await app.close();
    await f.close();
  }
});
