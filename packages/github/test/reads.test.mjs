import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { githubReadSchema } from '../src/read-contracts.ts';
import { dispatchGitHubRead, githubReadBindings } from '../src/read-provider.ts';
import { GitHubCredentialRejected } from '../src/accounts.ts';
import { toolContractDigest } from '@tulipfarm/provider-mcp';

const credential = {
  accessToken: 'synthetic-private-credential',
  accountId: 'account',
  membershipId: 'member',
  generation: 1,
  identity: { id: '1', login: 'owner' },
  scopes: ['repo'],
};
const repo = { owner: 'octocat', repo: 'hello-world' };
const cases = [
  [{ kind: 'repository.read', ...repo }, '/repos/octocat/hello-world'],
  [
    { kind: 'repository.search', query: 'org:octocat private' },
    '/search/repositories?per_page=10&page=1&q=org%3Aoctocat%20private',
  ],
  [
    { kind: 'file.read', ...repo, path: 'src/main.ts', ref: 'feature/read' },
    '/repos/octocat/hello-world/contents/src/main.ts?ref=feature%2Fread',
  ],
  [
    { kind: 'file.search', query: 'repo:octocat/hello-world test' },
    '/search/code?per_page=10&page=1&q=repo%3Aoctocat%2Fhello-world%20test',
  ],
  [{ kind: 'branch.list', ...repo }, '/repos/octocat/hello-world/branches?per_page=10&page=1'],
  [{ kind: 'branch.read', ...repo, branch: 'feature/read' }, '/repos/octocat/hello-world/branches/feature%2Fread'],
  [{ kind: 'pull.list', ...repo }, '/repos/octocat/hello-world/pulls?per_page=10&page=1&state=open'],
  [{ kind: 'pull.read', ...repo, number: 7 }, '/repos/octocat/hello-world/pulls/7'],
  [{ kind: 'pull.files', ...repo, number: 7 }, '/repos/octocat/hello-world/pulls/7/files?per_page=10&page=1'],
  [{ kind: 'pull.reviews', ...repo, number: 7 }, '/repos/octocat/hello-world/pulls/7/reviews?per_page=10&page=1'],
  [
    { kind: 'commit.checks', ...repo, ref: 'main' },
    '/repos/octocat/hello-world/commits/main/check-runs?per_page=10&page=1',
  ],
  [{ kind: 'issue.read', ...repo, number: 7 }, '/repos/octocat/hello-world/issues/7'],
  [{ kind: 'issue.comments', ...repo, number: 7 }, '/repos/octocat/hello-world/issues/7/comments?per_page=10&page=1'],
  [{ kind: 'release.list', ...repo }, '/repos/octocat/hello-world/releases?per_page=10&page=1'],
  [{ kind: 'release.read', ...repo, id: 7 }, '/repos/octocat/hello-world/releases/7'],
  [{ kind: 'release.assets', ...repo, id: 7 }, '/repos/octocat/hello-world/releases/7/assets?per_page=10&page=1'],
  [{ kind: 'actions.runs', ...repo }, '/repos/octocat/hello-world/actions/runs?per_page=10&page=1'],
  [{ kind: 'actions.run', ...repo, id: 7 }, '/repos/octocat/hello-world/actions/runs/7'],
  [{ kind: 'actions.jobs', ...repo, id: 7 }, '/repos/octocat/hello-world/actions/runs/7/jobs?per_page=10&page=1'],
  [{ kind: 'actions.artifacts', ...repo }, '/repos/octocat/hello-world/actions/artifacts?per_page=10&page=1'],
];
test('all bounded REST reads cross HTTP with the selected credential and fixed routes', async t => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, `Bearer ${credential.accessToken}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ observedPath: request.url, title: 'Private repository information' }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetcher = (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init);
  };
  for (const [operation, expected] of cases) {
    const result = await dispatchGitHubRead({ operation, credential, fetcher });
    assert.deepEqual(result, {
      transport: 'rest',
      data: { observedPath: expected, title: 'Private repository information' },
    });
  }
});
test('issue and pull search return compact pages that fit the result limit', async () => {
  const body = 'x'.repeat(4000);
  const item = number => ({
    url: `https://api.github.com/repos/octocat/hello-world/issues/${number}`,
    html_url: `https://github.com/octocat/hello-world/issues/${number}`,
    number,
    title: `Issue ${number}`,
    state: 'open',
    state_reason: null,
    user: { login: 'octocat', avatar_url: 'https://avatars.test/u'.repeat(20) },
    labels: [{ name: 'bug', description: 'd'.repeat(500) }],
    assignees: [{ login: 'hubot' }],
    milestone: { title: 'v1', description: 'm'.repeat(500) },
    comments: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    reactions: { url: 'r'.repeat(500) },
    body,
  });
  const paths = [];
  const fetcher = async url => {
    paths.push(new URL(url).pathname + new URL(url).search);
    return Response.json({
      total_count: 40,
      incomplete_results: false,
      items: Array.from({ length: 30 }, (_, index) => item(index + 1)),
    });
  };
  const result = await dispatchGitHubRead({
    operation: { kind: 'issue.search', query: 'org:octocat is:issue', perPage: 30 },
    credential,
    fetcher,
  });
  assert.equal(result.data.items.length, 30);
  assert.deepEqual(result.data.items[0], {
    url: 'https://api.github.com/repos/octocat/hello-world/issues/1',
    html_url: 'https://github.com/octocat/hello-world/issues/1',
    number: 1,
    title: 'Issue 1',
    state: 'open',
    state_reason: null,
    comments: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    user: 'octocat',
    labels: ['bug'],
    assignees: ['hubot'],
    milestone: 'v1',
    is_pull_request: false,
    body: 'x'.repeat(1000),
    body_truncated: true,
  });
  await dispatchGitHubRead({
    operation: { kind: 'pull.search', query: 'repo:octocat/hello-world fix' },
    credential,
    fetcher,
  });
  assert.deepEqual(paths, [
    '/search/issues?per_page=30&page=1&q=org%3Aoctocat%20is%3Aissue',
    '/search/issues?per_page=10&page=1&q=repo%3Aoctocat%2Fhello-world%20fix%20is%3Apr',
  ]);
});
test('reads reject arbitrary dispatch and unsafe payloads without exposing credentials', async () => {
  for (const operation of [
    { kind: 'delete', ...repo },
    { kind: 'repository.read', ...repo, url: 'https://evil.test' },
    { kind: 'file.read', ...repo, path: '../secret' },
    { kind: 'repository.search', query: 'x', perPage: 100 },
    { kind: 'repository.read', owner: '..', repo: 'x' },
  ])
    assert.equal(githubReadSchema.safeParse(operation).success, false);
  const operation = { kind: 'repository.read', ...repo };
  assert.deepEqual(
    await dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json({ name: 'safe' }) }),
    { transport: 'rest', data: { name: 'safe' } },
  );
  for (const value of [{ text: credential.accessToken }, { text: 'x'.repeat(131073) }])
    await assert.rejects(dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json(value) }));
  await assert.rejects(
    dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json({}, { status: 401 }) }),
    GitHubCredentialRejected,
  );
  await assert.rejects(
    dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json({}, { status: 403 }) }),
    /read-forbidden/,
  );
  assert.throws(() =>
    githubReadBindings({
      GITHUB_MCP_READ_BINDINGS: '[{"operation":"repository.search","name":"delete_repository","contractDigest":"x"}]',
    }),
  );
});
test('operator-qualified official MCP wins before dispatch and never fails over after catalog drift', async () => {
  const tool = {
    name: 'search_repositories',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        page: { type: 'number' },
        perPage: { type: 'number' },
        minimal_output: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
  const bindings = [{ operation: 'repository.search', name: tool.name, contractDigest: toolContractDigest(tool) }];
  let drift = false;
  const requests = [];
  const fetcher = async (url, init) => {
    assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
    assert.equal(new Headers(init.headers).get('X-MCP-Readonly'), 'true');
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push(body);
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'controlled-github', version: '1' },
          }
        : body.method === 'tools/list'
          ? { tools: [{ ...tool, name: drift ? 'changed' : tool.name }] }
          : { content: [{ type: 'text', text: 'Private repo found' }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  assert.deepEqual(
    await dispatchGitHubRead({
      operation: { kind: 'repository.search', query: 'private' },
      credential,
      bindings,
      fetcher,
    }),
    { transport: 'official-mcp', data: { content: [{ type: 'text', text: 'Private repo found' }] } },
  );
  assert.deepEqual(requests.find(item => item.method === 'tools/call').params, {
    name: 'search_repositories',
    arguments: { query: 'private', page: 1, perPage: 10, minimal_output: true },
  });
  drift = true;
  await assert.rejects(
    dispatchGitHubRead({ operation: { kind: 'repository.search', query: 'private' }, credential, bindings, fetcher }),
    /read-unqualified/,
  );
  assert.equal(requests.filter(item => item.method === 'tools/call').length, 1);
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'repository.search', query: 'private' },
      credential,
      bindings,
      fetcher: async () => Response.json({}, { status: 401 }),
    }),
    GitHubCredentialRejected,
  );
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'repository.search', query: 'private' },
      credential,
      bindings,
      fetcher: async () => Response.json({}, { status: 429 }),
    }),
    /read-rate-limited/,
  );
});

test('provider quota limits stay distinct from denied access and oversized evidence', async () => {
  for (const operation of [
    { kind: 'repository.read', ...repo },
    { kind: 'discussion.read', ...repo, number: 1 },
  ]) {
    for (const response of [
      { status: 429 },
      { status: 403, headers: { 'retry-after': '60' } },
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    ]) {
      await assert.rejects(
        dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json({}, response) }),
        /read-rate-limited/,
      );
    }
    await assert.rejects(
      dispatchGitHubRead({
        operation,
        credential,
        fetcher: async () => Response.json({}, { status: 403, headers: { 'x-ratelimit-remaining': '10' } }),
      }),
      /read-forbidden/,
    );
  }
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'discussion.read', ...repo, number: 1 },
      credential,
      fetcher: async () => Response.json({ errors: [{ type: 'RATE_LIMITED', message: 'Quota exceeded' }] }),
    }),
    /read-rate-limited/,
  );
});
