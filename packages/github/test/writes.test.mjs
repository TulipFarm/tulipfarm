import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { toolContractDigest } from '@tulipfarm/provider-mcp';
import { dispatchGitHubWrite, requireWriteTarget, githubWriteBindings } from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';

const credential = {
  accessToken: 'synthetic-private-credential',
  accountId: 'account',
  membershipId: 'member',
  generation: 1,
  identity: { id: '123', login: 'owner' },
  scopes: ['repo'],
};
const repository = { owner: 'octocat', repo: 'private' };
const create = { kind: 'issue.create', ...repository, title: 'Exact title', body: 'Exact body' };
test('all issue writes use fixed HTTP methods and exact payloads with no provider-content retention', async t => {
  const effects = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential.accessToken}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    effects.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 42, number: 7, body: 'Untrusted provider content' }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetcher = (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  };
  const operations = [
    create,
    { kind: 'issue.update', ...repository, issueNumber: 7, title: 'New title', body: 'New body' },
    { kind: 'issue.comment', ...repository, issueNumber: 7, body: 'Comment' },
    { kind: 'issue.close', ...repository, issueNumber: 7 },
    { kind: 'issue.reopen', ...repository, issueNumber: 7 },
  ];
  for (const operation of operations)
    assert.deepEqual(
      await dispatchGitHubWrite({ operation, credential, bindings: [], fetcher, authorize: async () => true }),
      { status: 'succeeded', result: { id: 42, number: 7 } },
    );
  assert.deepEqual(effects, [
    { method: 'POST', path: '/repos/octocat/private/issues', body: { title: 'Exact title', body: 'Exact body' } },
    { method: 'PATCH', path: '/repos/octocat/private/issues/7', body: { title: 'New title', body: 'New body' } },
    { method: 'POST', path: '/repos/octocat/private/issues/7/comments', body: { body: 'Comment' } },
    { method: 'PATCH', path: '/repos/octocat/private/issues/7', body: { state: 'closed' } },
    { method: 'PATCH', path: '/repos/octocat/private/issues/7', body: { state: 'open' } },
  ]);
});
test('qualified MCP writes use reviewed names and never fall back after dispatch or drift', async () => {
  const tool = {
    name: 'issue_write',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        method: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'method'],
      additionalProperties: false,
    },
  };
  const bindings = [{ operation: 'issue.create', name: tool.name, contractDigest: toolContractDigest(tool) }];
  let drift = false;
  const calls = [];
  const fetcher = async (url, init) => {
    assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'tools/call') calls.push(body.params);
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ ...tool, name: drift ? 'changed' : tool.name }] }
          : {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ id: '42', url: 'https://github.com/octocat/private/issues/7' }),
                },
              ],
            };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  const input = { operation: create, credential, bindings, fetcher, authorize: async () => true };
  assert.equal((await dispatchGitHubWrite(input)).status, 'succeeded');
  assert.deepEqual(calls, [
    {
      name: 'issue_write',
      arguments: { owner: 'octocat', repo: 'private', title: 'Exact title', body: 'Exact body', method: 'create' },
    },
  ]);
  drift = true;
  assert.deepEqual(await dispatchGitHubWrite(input), { status: 'unknown', result: null });
  assert.equal(calls.length, 1);
});
test('batch contracts reject empty, oversized, authority, placeholders and pull request targets', async () => {
  assert.deepEqual(githubBatchInputSchema.parse({ actions: [create] }).actions, [create]);
  for (const value of [
    { actions: [] },
    { actions: Array(11).fill(create) },
    { actions: [create], approve: true },
    { actions: [{ ...create, accountId: 'other' }] },
    { actions: [{ kind: 'issue.close', ...repository, issueNumber: '$previous' }] },
  ])
    assert.equal(githubBatchInputSchema.safeParse(value).success, false);
  await assert.rejects(
    requireWriteTarget({ kind: 'issue.close', ...repository, issueNumber: 7 }, credential, async () =>
      Response.json({ id: 7, pull_request: {} }),
    ),
    /batch-conflict/,
  );
  assert.throws(() =>
    githubWriteBindings({
      GITHUB_MCP_WRITE_BINDINGS: '[{"operation":"issue.create","name":"delete_repository","contractDigest":"fake"}]',
    }),
  );
});
