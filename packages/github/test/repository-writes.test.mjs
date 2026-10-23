import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  dispatchGitHubWrite,
  requireWriteTarget,
  reconcileGitHubWrite,
  githubWriteBindings,
} from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';
import { toolContractDigest } from '@tulipfarm/provider-mcp';

const credential = {
  accessToken: 'synthetic-repository-credential',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo', 'delete_repo'],
};
const target = { owner: 'octocat', repo: 'private', repositoryId: 42 },
  sha = 'a'.repeat(40);
export const repositoryCases = [
  {
    operation: {
      kind: 'repository.create',
      owner: 'octocat',
      repo: 'new',
      ownerType: 'user',
      ownerId: 123,
      description: 'New repository',
      private: true,
      autoInit: true,
    },
    method: 'POST',
    path: '/user/repos',
    body: { name: 'new', description: 'New repository', private: true, auto_init: true },
    status: 201,
    output: { id: 43, full_name: 'octocat/new' },
    receipt: { repositoryId: 43 },
  },
  {
    operation: {
      kind: 'repository.create',
      owner: 'acme',
      repo: 'new',
      ownerType: 'organization',
      ownerId: 456,
      description: '',
      private: false,
      autoInit: false,
    },
    method: 'POST',
    path: '/orgs/acme/repos',
    body: { name: 'new', description: '', private: false, auto_init: false },
    status: 201,
    output: { id: 44, full_name: 'acme/new' },
    receipt: { repositoryId: 44 },
  },
  {
    operation: {
      kind: 'repository.settings',
      ...target,
      description: 'Updated',
      private: true,
      hasIssues: true,
      hasWiki: false,
      defaultBranch: 'main',
    },
    method: 'PATCH',
    path: '/repos/octocat/private',
    body: { description: 'Updated', private: true, has_issues: true, has_wiki: false, default_branch: 'main' },
    status: 200,
    output: { id: 42, full_name: 'octocat/private' },
    receipt: { repositoryId: 42 },
  },
  {
    operation: { kind: 'repository.rename', ...target, name: 'renamed' },
    method: 'PATCH',
    path: '/repos/octocat/private',
    body: { name: 'renamed' },
    status: 200,
    output: { id: 42, full_name: 'octocat/renamed' },
    receipt: { repositoryId: 42 },
  },
  {
    operation: { kind: 'repository.archive', ...target, archived: true },
    method: 'PATCH',
    path: '/repos/octocat/private',
    body: { archived: true },
    status: 200,
    output: { id: 42, full_name: 'octocat/private' },
    receipt: { repositoryId: 42 },
  },
  {
    operation: { kind: 'repository.delete', ...target },
    method: 'DELETE',
    path: '/repos/octocat/private',
    status: 204,
    receipt: { repositoryId: 42, deleted: true },
  },
  {
    operation: { kind: 'branch.create', ...target, branch: 'feature/next', headSha: sha },
    method: 'POST',
    path: '/repos/octocat/private/git/refs',
    body: { ref: 'refs/heads/feature/next', sha },
    status: 201,
    output: { ref: 'refs/heads/feature/next', object: { type: 'commit', sha } },
    receipt: { repositoryId: 42, headSha: sha },
  },
  {
    operation: { kind: 'branch.delete', ...target, branch: 'feature/next', headSha: sha },
    method: 'DELETE',
    path: '/repos/octocat/private/git/refs/heads/feature%2Fnext',
    status: 204,
    receipt: { repositoryId: 42, deleted: true, headSha: sha },
  },
];

for (const item of repositoryCases)
  test(`real HTTP ${item.operation.kind} ${item.operation.owner} accepts only documented completion`, async t => {
    const effects = [];
    let status = item.status;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      effects.push({ method: request.method, path: request.url, ...(text ? { body: JSON.parse(text) } : {}) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 ? undefined : JSON.stringify(item.output ?? {}));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const fetcher = (url, init) => {
      assert.equal(new URL(url).origin, 'https://api.github.com');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, `Bearer ${credential.accessToken}`);
      return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
    };
    const operation = githubBatchInputSchema.parse({ actions: [item.operation] }).actions[0];
    const run = () =>
      dispatchGitHubWrite({ operation, credential, bindings: [], fetcher, authorize: async () => true });
    assert.deepEqual(await run(), { status: 'succeeded', result: item.receipt });
    assert.deepEqual(effects[0], { method: item.method, path: item.path, ...(item.body ? { body: item.body } : {}) });
    status = 202;
    assert.deepEqual(await run(), { status: 'unknown', result: null });
    status = 404;
    assert.deepEqual(await run(), { status: 'rejected', result: null });
  });

test('repository identity, admin, deletion scope, owner and branch head fence dispatch but changed heads do not poison review', async () => {
  const repository = {
    id: 42,
    full_name: 'octocat/private',
    default_branch: 'main',
    archived: false,
    permissions: { admin: true, push: true },
  };
  const deletion = repositoryCases[5].operation,
    branch = repositoryCases[7].operation;
  const read = value => async () => Response.json(value);
  await requireWriteTarget(deletion, credential, read(repository), true);
  for (const changed of [{ id: 99 }, { full_name: 'other/private' }, { permissions: { admin: false, push: true } }])
    await assert.rejects(
      requireWriteTarget(deletion, credential, read({ ...repository, ...changed }), true),
      /batch-conflict/,
    );
  const branchRead = async url =>
    Response.json(
      String(url).includes('/git/ref/')
        ? { ref: 'refs/heads/feature/next', object: { type: 'commit', sha: 'b'.repeat(40) } }
        : repository,
    );
  await assert.rejects(requireWriteTarget(branch, credential, branchRead, true), /batch-conflict/);
  await requireWriteTarget(branch, credential, branchRead, false);
  await assert.rejects(
    requireWriteTarget(
      repositoryCases[0].operation,
      credential,
      read({ id: 999, login: 'octocat', type: 'User' }),
      true,
    ),
    /batch-conflict/,
  );
});

test('unknown repository and branch effects remain unresolved after 404 or matching state, without mutation retries', async () => {
  for (const item of repositoryCases)
    for (const status of [200, 403, 404]) {
      const result = await reconcileGitHubWrite({
        operation: item.operation,
        credential,
        marker: '',
        fetcher: async (_url, init) => {
          assert.equal(init.method, 'GET');
          return Response.json(item.output ?? {}, { status });
        },
      });
      assert.equal(result.result, null);
      assert.equal(result.evidence.outcome, 'unresolved');
      assert.equal(result.evidence.status, status);
    }
});

test('qualified repository creation parses official compact string IDs and never falls back', async () => {
  for (const item of repositoryCases.slice(0, 2)) {
    const operation = item.operation;
    const args = {
      name: 'new',
      description: operation.description,
      private: operation.private,
      autoInit: operation.autoInit,
      ...(operation.ownerType === 'organization' ? { organization: operation.owner } : {}),
    };
    const tool = {
      name: 'create_repository',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, { const: value }])),
        required: Object.keys(args),
        additionalProperties: false,
      },
    };
    const bindings = githubWriteBindings({
      GITHUB_MCP_WRITE_BINDINGS: JSON.stringify([
        { operation: 'repository.create', name: tool.name, contractDigest: toolContractDigest(tool) },
      ]),
    });
    let text = JSON.stringify({ id: '9007199254740993', url: `https://github.com/${operation.owner}/new` });
    const calls = [];
    const fetcher = async (url, init) => {
      assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
      const request = init.body ? JSON.parse(init.body) : {};
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (request.method === 'tools/call') calls.push(request.params.arguments);
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : request.method === 'tools/list'
            ? { tools: [tool] }
            : { content: [{ type: 'text', text }] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    };
    const run = () => dispatchGitHubWrite({ operation, credential, bindings, fetcher, authorize: async () => true });
    assert.deepEqual(await run(), { status: 'succeeded', result: { repositoryId: '9007199254740993' } });
    assert.deepEqual(calls, [args]);
    text = JSON.stringify({ id: 42, full_name: `${operation.owner}/new` });
    assert.deepEqual(await run(), { status: 'unknown', result: null });
  }
});

test('unsafe refs, unpinned targets, generic requests and unqualified MCP mappings are rejected', () => {
  for (const change of [
    { repositoryId: undefined },
    { headSha: 'main' },
    { branch: 'x/.hidden' },
    { branch: 'x.lock/y' },
    { force: true },
    { url: 'https://other.test' },
  ])
    assert.equal(
      githubBatchInputSchema.safeParse({ actions: [{ ...repositoryCases[6].operation, ...change }] }).success,
      false,
    );
  assert.equal(githubBatchInputSchema.safeParse({ actions: [repositoryCases[6].operation] }).success, true);
  for (const [operation, name] of [
    ['branch.create', 'create_branch'],
    ['repository.delete', 'delete_repository'],
  ])
    assert.throws(() =>
      githubWriteBindings({
        GITHUB_MCP_WRITE_BINDINGS: JSON.stringify([{ operation, name, contractDigest: 'a'.repeat(64) }]),
      }),
    );
  assert.equal(
    githubBatchInputSchema.safeParse({
      actions: [repositoryCases[0].operation, { ...repositoryCases[6].operation, repo: 'new' }],
    }).success,
    false,
  );
});
