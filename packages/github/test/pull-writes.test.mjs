import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { toolContractDigest } from '@tulipfarm/provider-mcp';
import {
  dispatchGitHubWrite,
  requireWriteTarget,
  reconcileGitHubWrite,
  githubWriteBindings,
} from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';
import { mcpWriteCases } from './mcp-write-fixture.mjs';

const credential = {
  accessToken: 'synthetic-private-credential',
  identity: { id: '123', login: 'owner' },
  scopes: ['repo'],
};
const repo = { owner: 'octocat', repo: 'private', repositoryId: 42 };
const target = { ...repo, pullNumber: 7, pullRequestId: 77 };
const sha = 'a'.repeat(40),
  marker = '<!-- tulipfarm:fixture:0 -->';
const merge = {
  kind: 'pull.merge',
  ...target,
  headSha: sha,
  base: 'main',
  mergeMethod: 'squash',
  commitTitle: 'Ship fix',
  commitMessage: 'Reviewed changes',
};
const pull = {
  id: 77,
  number: 7,
  base: { ref: 'main', repo: { id: 42 } },
  head: { sha, ref: 'fix' },
  state: 'open',
  merged: false,
  draft: false,
};
const repository = { id: 42, full_name: 'octocat/private', archived: false, permissions: { push: true } };

test('all eight pull writes dispatch exact bounded HTTP operations and retain only receipts', async t => {
  const effects = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential.accessToken}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    effects.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(request.url.endsWith('/reviews') ? 200 : request.method === 'POST' ? 201 : 200, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify(
        request.url.endsWith('/merge')
          ? { merged: true, sha, message: 'Merged' }
          : { id: 77, number: 7, body: 'Do not retain provider text' },
      ),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetcher = (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  };
  const actions = [
    { kind: 'pull.create', ...repo, head: 'fix', base: 'main', title: 'Fix', body: 'Description', draft: false },
    { kind: 'pull.update', ...target, title: 'Edited', body: 'Revised', base: 'main' },
    { kind: 'pull.comment', ...target, body: 'Comment' },
    { kind: 'pull.review', ...target, headSha: sha, body: 'Reviewed', event: 'APPROVE' },
    { kind: 'pull.request-reviewers', ...target, reviewers: ['octocat'], teamReviewers: ['engineers'] },
    { kind: 'pull.close', ...target },
    { kind: 'pull.reopen', ...target },
    merge,
  ];
  for (const operation of githubBatchInputSchema.parse({ actions }).actions)
    assert.deepEqual(
      await dispatchGitHubWrite({ operation, credential, bindings: [], fetcher, authorize: async () => true }),
      { status: 'succeeded', result: operation.kind === 'pull.merge' ? { merged: true, sha } : { id: 77, number: 7 } },
    );
  assert.deepEqual(effects, [
    {
      method: 'POST',
      path: '/repos/octocat/private/pulls',
      body: { title: 'Fix', body: 'Description', head: 'fix', base: 'main', draft: false },
    },
    {
      method: 'PATCH',
      path: '/repos/octocat/private/pulls/7',
      body: { title: 'Edited', body: 'Revised', base: 'main' },
    },
    { method: 'POST', path: '/repos/octocat/private/issues/7/comments', body: { body: 'Comment' } },
    {
      method: 'POST',
      path: '/repos/octocat/private/pulls/7/reviews',
      body: { body: 'Reviewed', commit_id: sha, event: 'APPROVE' },
    },
    {
      method: 'POST',
      path: '/repos/octocat/private/pulls/7/requested_reviewers',
      body: { reviewers: ['octocat'], team_reviewers: ['engineers'] },
    },
    { method: 'PATCH', path: '/repos/octocat/private/pulls/7', body: { state: 'closed' } },
    { method: 'PATCH', path: '/repos/octocat/private/pulls/7', body: { state: 'open' } },
    {
      method: 'PUT',
      path: '/repos/octocat/private/pulls/7/merge',
      body: { sha, merge_method: 'squash', commit_title: 'Ship fix', commit_message: 'Reviewed changes' },
    },
  ]);
});

test('strict contracts reject unpinned merges, authority, endpoints, and unsafe branch targets', () => {
  assert.equal(githubBatchInputSchema.parse({ actions: [merge] }).actions[0].headSha, sha);
  for (const change of [
    { headSha: undefined },
    { repositoryId: undefined },
    { pullRequestId: undefined },
    { headSha: 'main' },
    { force: true },
    { url: 'https://evil.test' },
    { base: '../main' },
    { mergeMethod: 'admin' },
  ])
    assert.equal(githubBatchInputSchema.safeParse({ actions: [{ ...merge, ...change }] }).success, false);
  assert.throws(() =>
    githubWriteBindings({
      GITHUB_MCP_WRITE_BINDINGS: JSON.stringify([
        { operation: 'pull.merge', name: 'update_pull_request', contractDigest: 'a'.repeat(64) },
      ]),
    }),
  );
});

test('REST accepts only each operation documented success status, including review 200', async () => {
  const statuses = {
    'issue.create': 201,
    'issue.update': 200,
    'issue.comment': 201,
    'issue.close': 200,
    'issue.reopen': 200,
    'pull.create': 201,
    'pull.update': 200,
    'pull.comment': 201,
    'pull.review': 200,
    'pull.request-reviewers': 201,
    'pull.close': 200,
    'pull.reopen': 200,
    'pull.merge': 200,
  };
  for (const { operation } of mcpWriteCases)
    for (const status of [200, 201, 202, 204]) {
      const expected = statuses[operation.kind] === status;
      const result = operation.kind === 'pull.merge' ? { merged: true, sha } : { id: 77, number: 7 };
      assert.deepEqual(
        await dispatchGitHubWrite({
          operation,
          credential,
          bindings: [],
          authorize: async () => true,
          fetcher: async () => (status === 204 ? new Response(null, { status }) : Response.json(result, { status })),
        }),
        { status: expected ? 'succeeded' : 'unknown', result: expected ? result : null },
      );
    }
});

test('a repository named pulls does not change the comment endpoint repository', async () => {
  const paths = [];
  const result = await dispatchGitHubWrite({
    operation: { kind: 'pull.comment', ...target, repo: 'pulls', body: 'Comment' },
    credential,
    bindings: [],
    authorize: async () => true,
    fetcher: async url => {
      paths.push(new URL(url).pathname);
      return Response.json({ id: 123 }, { status: 201 });
    },
  });
  assert.deepEqual(result, { status: 'succeeded', result: { id: 123 } });
  assert.deepEqual(paths, ['/repos/octocat/pulls/issues/7/comments']);
});

test('target checks pin repository and pull identity while review access survives changed heads and merge', async () => {
  const run = (repoChange, pullChange, dispatch) =>
    requireWriteTarget(
      merge,
      credential,
      async url =>
        Response.json(String(url).endsWith('/pulls/7') ? { ...pull, ...pullChange } : { ...repository, ...repoChange }),
      dispatch,
    );
  await run({}, {}, true);
  for (const change of [{ id: 99 }, { full_name: 'other/private' }])
    await assert.rejects(run(change, {}, false), /batch-conflict/);
  for (const change of [{ id: 99 }, { number: 9 }, { base: { ref: 'main', repo: { id: 99 } } }])
    await assert.rejects(run({}, change, false), /batch-conflict/);
  for (const change of [
    { head: { sha: 'b'.repeat(40), ref: 'fix' } },
    { merged: true },
    { state: 'closed' },
    { draft: true },
    { base: { ref: 'different', repo: { id: 42 } } },
  ]) {
    await assert.rejects(run({}, change, true), /batch-conflict/);
    await run({}, change, false);
  }
  await assert.rejects(run({ archived: true }, {}, true), /batch-conflict/);
  await assert.rejects(run({ permissions: { push: false } }, {}, true), /batch-conflict/);
});

test('merge rejection, racing head conflicts, uncertain errors, and denied authorization never claim success', async () => {
  for (const status of [403, 405, 409, 422, 500])
    assert.deepEqual(
      await dispatchGitHubWrite({
        operation: merge,
        credential,
        bindings: [],
        fetcher: async () => Response.json({}, { status }),
        authorize: async () => true,
      }),
      { status: status === 500 ? 'unknown' : 'rejected', result: null },
    );
  assert.deepEqual(
    await dispatchGitHubWrite({
      operation: merge,
      credential,
      bindings: [],
      fetcher: async () => Response.json({ merged: false }),
      authorize: async () => true,
    }),
    { status: 'rejected', result: null },
  );
  assert.deepEqual(
    await dispatchGitHubWrite({
      operation: merge,
      credential,
      bindings: [],
      fetcher: async () => {
        throw new Error('must not dispatch');
      },
      authorize: async () => false,
    }),
    { status: 'rejected', result: null },
  );
});

test('recovery attributes create, comment and review markers but never infers merge success from state alone', async () => {
  const body = `Exact\n\n${marker}`;
  for (const operation of [
    { kind: 'pull.create', ...repo, head: 'fix', base: 'main', title: 'Fix', body, draft: false },
    { kind: 'pull.comment', ...target, body },
    { kind: 'pull.review', ...target, headSha: sha, event: 'APPROVE', body },
  ]) {
    const item = { ...pull, title: 'Fix', body, user: { id: 123 }, commit_id: sha, state: 'APPROVED' };
    const run = items =>
      reconcileGitHubWrite({ operation, credential, fetcher: async () => Response.json(items), marker });
    assert.deepEqual((await run([item])).result, { id: 77, number: 7 });
    for (const items of [[{ ...item, user: { id: 999 } }], [{ ...item, body: 'Similar' }], [item, item], []])
      assert.equal((await run(items)).result, null);
    if (operation.kind === 'pull.review')
      assert.equal((await run([{ ...item, commit_id: 'b'.repeat(40) }])).result, null);
  }
  const result = await reconcileGitHubWrite({
    operation: merge,
    credential,
    fetcher: async () => Response.json({ ...pull, merged: true, merged_by: { id: 123 } }),
    marker,
  });
  assert.equal(result.result, null);
  assert.equal(result.evidence.outcome, 'unresolved');
});

test('reviewed MCP merge carries expectedHeadSha and requires structured merge evidence without fallback', async () => {
  const tool = {
    name: 'merge_pull_request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pullNumber: { type: 'integer' },
        expectedHeadSha: { type: 'string' },
        merge_method: { type: 'string' },
        commit_title: { type: 'string' },
        commit_message: { type: 'string' },
      },
      required: ['owner', 'repo', 'pullNumber', 'expectedHeadSha'],
      additionalProperties: false,
    },
  };
  const bindings = [{ operation: 'pull.merge', name: tool.name, contractDigest: toolContractDigest(tool) }];
  const calls = [];
  let mode = 'success';
  const fetcher = async (url, init) => {
    assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'tools/call') {
      calls.push(body.params);
      if (mode === 'lost') throw new Error('Lost ack');
    }
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [mode === 'drift' ? { ...tool, name: 'changed' } : tool] }
          : {
              content: [
                { type: 'text', text: mode === 'text' ? 'Maybe merged' : JSON.stringify({ merged: true, sha }) },
              ],
            };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  const run = () =>
    dispatchGitHubWrite({ operation: merge, credential, bindings, fetcher, authorize: async () => true });
  assert.deepEqual(await run(), { status: 'succeeded', result: { merged: true, sha } });
  assert.deepEqual(calls[0], {
    name: 'merge_pull_request',
    arguments: {
      owner: 'octocat',
      repo: 'private',
      pullNumber: 7,
      expectedHeadSha: sha,
      merge_method: 'squash',
      commit_title: 'Ship fix',
      commit_message: 'Reviewed changes',
    },
  });
  for (const failure of ['text', 'lost', 'drift']) {
    mode = failure;
    assert.deepEqual(await run(), { status: 'unknown', result: null });
  }
  assert.equal(calls.length, 3);
});

test('every remaining reviewed pull MCP mapping sends only the approved provider arguments', async () => {
  const cases = [
    [
      { kind: 'pull.create', ...repo, title: 'New', body: 'Description', head: 'fix', base: 'main', draft: true },
      'create_pull_request',
      { owner: 'octocat', repo: 'private', title: 'New', body: 'Description', head: 'fix', base: 'main', draft: true },
    ],
    [
      { kind: 'pull.update', ...target, title: 'Edit', body: 'Updated', base: 'main' },
      'update_pull_request',
      { owner: 'octocat', repo: 'private', pullNumber: 7, title: 'Edit', body: 'Updated', base: 'main' },
    ],
    [
      { kind: 'pull.comment', ...target, body: 'Comment' },
      'add_issue_comment',
      { owner: 'octocat', repo: 'private', issue_number: 7, body: 'Comment' },
    ],
    [
      { kind: 'pull.review', ...target, headSha: sha, body: 'Review', event: 'REQUEST_CHANGES' },
      'pull_request_review_write',
      {
        owner: 'octocat',
        repo: 'private',
        pullNumber: 7,
        method: 'create',
        commitID: sha,
        body: 'Review',
        event: 'REQUEST_CHANGES',
      },
    ],
    [
      { kind: 'pull.request-reviewers', ...target, reviewers: ['reviewer'], teamReviewers: ['engineers'] },
      'request_pull_request_reviewers',
      { owner: 'octocat', repo: 'private', pullNumber: 7, reviewers: ['reviewer', 'octocat/engineers'] },
    ],
    [
      { kind: 'pull.close', ...target },
      'update_pull_request',
      { owner: 'octocat', repo: 'private', pullNumber: 7, state: 'closed' },
    ],
    [
      { kind: 'pull.reopen', ...target },
      'update_pull_request',
      { owner: 'octocat', repo: 'private', pullNumber: 7, state: 'open' },
    ],
  ];
  for (const [operation, name, expected] of cases) {
    const official = mcpWriteCases.find(item => item.operation.kind === operation.kind);
    const tool = {
      name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, { const: value }])),
        required: Object.keys(expected),
        additionalProperties: false,
      },
    };
    const calls = [];
    const fetcher = async (url, init) => {
      assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'tools/call') calls.push(body.params);
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : body.method === 'tools/list'
            ? { tools: [tool] }
            : { content: [{ type: 'text', text: official.text }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    const bindings = githubWriteBindings({
      GITHUB_MCP_WRITE_BINDINGS: JSON.stringify([
        { operation: operation.kind, name, contractDigest: toolContractDigest(tool) },
      ]),
    });
    assert.deepEqual(
      await dispatchGitHubWrite({ operation, credential, bindings, fetcher, authorize: async () => true }),
      { status: 'succeeded', result: official.receipt },
    );
    assert.deepEqual(calls, [{ name, arguments: expected }]);
  }
});
