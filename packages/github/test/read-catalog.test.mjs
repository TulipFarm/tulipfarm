import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { graphql } from 'graphql';
import { projectSchema } from './project-provider-fixture.mjs';
import { githubReadMatrix } from '../src/read-matrix.ts';
import { dispatchGitHubRead, githubReadBindings } from '../src/read-provider.ts';
import { toolContractDigest } from '@tulipfarm/provider-mcp';

const credential = {
  accessToken: 'synthetic-private-credential',
  accountId: 'account',
  membershipId: 'member',
  generation: 1,
  identity: { id: '1', login: 'owner' },
  scopes: ['repo', 'read:project'],
};
const repo = { owner: 'octocat', repo: 'private' };
const pageInfo = { hasNextPage: false, endCursor: null };
const page = nodes => ({ nodes, pageInfo });
const project = {
  id: 'PVT_1',
  number: 7,
  owner: { id: 'U_1', login: 'octocat', __typename: 'User' },
  title: 'Roadmap',
  shortDescription: 'Private plan',
  readme: 'Deliver safely',
  url: 'https://github.com/users/octocat/projects/7',
  closed: false,
  public: false,
};
const comment = {
  id: 'DC_1',
  body: 'Private answer',
  url: 'https://github.com/octocat/private/discussions/7#discussioncomment-1',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  author: { login: 'octocat' },
};
const category = { id: 'DIC_1', name: 'Help', description: 'Questions', emoji: ':question:', isAnswerable: true };
const repositoryIdentity = {
  id: 'R_42',
  databaseId: 42,
  name: 'private',
  nameWithOwner: 'octocat/private',
  owner: { id: 'U_1', login: 'octocat' },
};
const discussion = {
  id: 'D_1',
  number: 7,
  title: 'Question',
  body: 'Private discussion',
  repository: repositoryIdentity,
  url: 'https://github.com/octocat/private/discussions/7',
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  locked: false,
  author: comment.author,
  category,
  answer: comment,
};
const item = {
  id: 'PVTI_1',
  type: 'DRAFT_ISSUE',
  isArchived: false,
  updatedAt: comment.updatedAt,
  content: { __typename: 'DraftIssue', id: 'DI_1', title: 'Plan', body: 'Private draft' },
  project: { number: 7, owner: { __typename: 'User', login: 'octocat' } },
  fieldValues: page([
    {
      __typename: 'ProjectV2ItemFieldTextValue',
      text: 'Review',
      field: { __typename: 'ProjectV2Field', id: 'PVTF_1', name: 'Notes' },
    },
  ]),
};
const field = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'PVTSSF_1',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'opt1', name: 'Ready', color: 'GREEN', description: 'Ready for work' }],
};
const apiSchema = projectSchema;

async function http(t, handle) {
  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      t.diagnostic(String(error));
      response.writeHead(500);
      response.end(String(error));
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init);
  };
}

test('all fixed GraphQL reads execute against the published GitHub schema over HTTP and return private objects', async t => {
  const observed = [];
  const fetcher = await http(t, async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/graphql');
    assert.equal(request.headers.authorization, `Bearer ${credential.accessToken}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    observed.push(body);
    const projectOwner = {
      id: 'U_1',
      login: 'octocat',
      __typename: body.variables.ownerType === 'organization' ? 'Organization' : 'User',
    };
    const owner = {
      ...projectOwner,
      viewerCanCreateProjects: true,
      projectsV2: ({ first, after, query }) => {
        assert.equal(first, 2);
        assert.equal(after, 'cursor-one');
        assert.equal(query, 'Roadmap');
        return page([{ ...project, owner: projectOwner }]);
      },
      projectV2: { ...project, owner: projectOwner, fields: page([field]), items: page([item]) },
    };
    const result = await graphql({
      schema: apiSchema,
      source: body.query,
      variableValues: body.variables,
      typeResolver: value => value.__typename ?? 'User',
      rootValue: {
        user: owner,
        organization: owner,
        repository: {
          discussions: page([discussion]),
          discussion: { ...discussion, comments: page([{ ...comment, replyTo: null, replies: { totalCount: 1 } }]) },
          discussionCategories: page([category]),
        },
        search: { ...page([{ ...discussion, __typename: 'Discussion' }]), discussionCount: 1 },
        node: ({ id }) =>
          id === 'PVTI_1'
            ? {
                ...item,
                fieldValueByName: ({ name }) => {
                  assert.equal(name, 'Assignees');
                  return {
                    __typename: 'ProjectV2ItemFieldUserValue',
                    field: { __typename: 'ProjectV2Field', id: 'PVTF_2', name },
                    users: ({ first, after }) => {
                      assert.equal(first, 2);
                      assert.equal(after, 'cursor-one');
                      return page([{ id: 'U_1', login: 'octocat' }]);
                    },
                  };
                },
                project: {
                  id: 'PVT_1',
                  number: 7,
                  owner: {
                    id: 'U_1',
                    __typename: body.variables.ownerType === 'organization' ? 'Organization' : 'User',
                    login: 'octocat',
                  },
                },
                __typename: 'ProjectV2Item',
              }
            : {
                ...comment,
                __typename: 'DiscussionComment',
                discussion,
                replies: page([{ ...comment, id: 'DC_2', replyTo: { id: 'DC_1' } }]),
              },
      },
    });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  for (const [kind, definition] of Object.entries(githubReadMatrix)) {
    if (definition.transport !== 'graphql') continue;
    for (const ownerType of kind.startsWith('project.') ? ['user', 'organization'] : [undefined]) {
      const operation = kind.startsWith('project.')
        ? { kind, owner: 'octocat', ownerType }
        : kind === 'discussion.search'
          ? { kind, query: 'repo:octocat/private question' }
          : { kind, ...repo };
      if (
        [
          'project.read',
          'project.fields',
          'project.items',
          'project.item',
          'project.item-field',
          'discussion.read',
          'discussion.comments',
          'discussion.replies',
        ].includes(kind)
      )
        operation.number = 7;
      if (!['project.read', 'discussion.read'].includes(kind))
        Object.assign(operation, { perPage: 2, after: 'cursor-one' });
      if (kind === 'project.list') operation.query = 'Roadmap';
      if (kind === 'project.item' || kind === 'project.item-field') operation.itemId = 'PVTI_1';
      if (kind === 'project.item-field') operation.fieldName = 'Assignees';
      if (kind === 'discussion.replies') operation.commentId = 'DC_1';
      const result = await dispatchGitHubRead({ operation, credential, fetcher });
      assert.equal(result.transport, 'graphql');
      if (kind === 'project.read')
        assert.deepEqual(result.data, {
          ...project,
          owner: { ...project.owner, __typename: ownerType === 'organization' ? 'Organization' : 'User' },
        });
      else if (kind === 'discussion.read') assert.equal(result.data.answer.body, 'Private answer');
      else if (kind === 'project.item') assert.equal(result.data.fieldValues.nodes[0].text, 'Review');
      else if (kind === 'project.item-field')
        assert.deepEqual(result.data.fieldValueByName.users, page([{ id: 'U_1', login: 'octocat' }]));
      else {
        assert.equal(result.data.nodes.length, 1);
        assert.equal(
          result.data.nodes[0].id,
          {
            'project.list': 'PVT_1',
            'project.fields': 'PVTSSF_1',
            'project.items': 'PVTI_1',
            'discussion.list': 'D_1',
            'discussion.categories': 'DIC_1',
            'discussion.comments': 'DC_1',
            'discussion.replies': 'DC_2',
            'discussion.search': 'D_1',
          }[kind],
        );
        assert.deepEqual(result.data.pageInfo, pageInfo);
      }
    }
  }
  assert.equal(observed.length, 18);
});

test('GraphQL errors, null roots, foreign nodes, oversized pages and arbitrary documents fail closed', async () => {
  const operation = { kind: 'project.read', owner: 'octocat', ownerType: 'user', number: 7 };
  assert.equal(
    (
      await dispatchGitHubRead({
        operation,
        credential,
        fetcher: async () => Response.json({ data: { target: { result: project } } }),
      })
    ).data.title,
    'Roadmap',
  );
  for (const value of [
    { data: { target: { result: project } }, errors: [{ message: 'denied' }] },
    { data: { target: null } },
    { data: {} },
  ])
    await assert.rejects(dispatchGitHubRead({ operation, credential, fetcher: async () => Response.json(value) }));
  await assert.rejects(
    dispatchGitHubRead({ operation: { ...operation, query: 'mutation { deleteProjectV2 }' }, credential }),
  );
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'project.item', owner: 'other', ownerType: 'user', number: 7, itemId: 'PVTI_1' },
      credential,
      fetcher: async () => Response.json({ data: { target: item } }),
    }),
    /read-forbidden/,
  );
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'discussion.list', ...repo, perPage: 1 },
      credential,
      fetcher: async () => Response.json({ data: { target: { result: page([discussion, discussion]) } } }),
    }),
    /read-limit/,
  );
});

test('REST additions parse diffs, raw text, directory pages, PR head checks and asset metadata over HTTP', async t => {
  const fetcher = await http(t, (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential.accessToken}`);
    const url = request.url;
    if (request.headers.accept === 'application/vnd.github.diff') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('diff --git a/a b/a\n+safe change\n');
    }
    if (request.headers.accept === 'application/vnd.github.raw+json') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('export const result = "read";\n');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    const body =
      url === '/repos/octocat/private/pulls/7'
        ? { head: { sha: 'a'.repeat(40) } }
        : url.includes('/commits/')
          ? { total_count: 1, check_runs: [{ name: 'CI', conclusion: 'success' }] }
          : url === '/repos/octocat/private/contents/'
            ? [
                { name: 'a', path: 'a', sha: 'abc', size: 1, type: 'file' },
                { name: 'b', path: 'b', sha: 'def', size: 2, type: 'file' },
              ]
            : url.includes('/contents/')
              ? { type: 'file', size: 28 }
              : { id: 7, name: 'release.zip', size: 1024, path: url };
    response.end(JSON.stringify(body));
  });
  const read = operation => dispatchGitHubRead({ operation: { ...repo, ...operation }, credential, fetcher });
  assert.deepEqual((await read({ kind: 'pull.diff', number: 7 })).data, {
    text: 'diff --git a/a b/a\n+safe change\n',
    complete: true,
  });
  assert.deepEqual((await read({ kind: 'file.content', path: 'src/main.ts', ref: 'feature/read' })).data, {
    text: 'export const result = "read";\n',
    complete: true,
  });
  assert.deepEqual((await read({ kind: 'file.list', perPage: 1, page: 2 })).data, {
    entries: [{ name: 'b', path: 'b', sha: 'def', size: 2, type: 'file' }],
    nextPage: null,
    directoryLimitReached: false,
  });
  for (const kind of ['pull.checks', 'pull.status'])
    assert.deepEqual((await read({ kind, number: 7 })).data, {
      headSha: 'a'.repeat(40),
      result: { total_count: 1, check_runs: [{ name: 'CI', conclusion: 'success' }] },
    });
  for (const [kind, path] of [
    ['pull.comments', '/issues/7/comments?per_page=10&page=1'],
    ['pull.review-comments', '/pulls/7/comments?per_page=10&page=1'],
    ['pull.commits', '/pulls/7/commits?per_page=10&page=1'],
    ['release.asset', '/releases/assets/7'],
    ['actions.artifact', '/actions/artifacts/7'],
  ]) {
    const result = await read({ kind, ...(kind.startsWith('pull.') ? { number: 7 } : { id: 7 }) });
    assert.equal(result.data.path, `/repos/octocat/private${path}`);
    assert.equal(result.data.name, 'release.zip');
  }
  assert.equal((await read({ kind: 'commit.status', ref: 'feature/test' })).data.check_runs[0].conclusion, 'success');
});

test('job logs strip authorization across the approved redirect and reject unsafe destinations and oversized text', async () => {
  const operation = { kind: 'actions.logs', ...repo, id: 7 };
  let location = 'https://productionresultssa1.blob.core.windows.net/logs/job.txt?sig=private';
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).startsWith('https://api.github.com/')
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('Build passed\n');
  };
  assert.deepEqual((await dispatchGitHubRead({ operation, credential, fetcher })).data, {
    text: 'Build passed\n',
    complete: true,
  });
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.redirect, 'error');
  for (const bad of [
    'https://evil.test/log',
    'http://productionresultssa1.blob.core.windows.net/log',
    'https://productionresultssa1.blob.core.windows.net.evil.test/log',
    'https://api.github.com/log',
  ]) {
    location = bad;
    await assert.rejects(dispatchGitHubRead({ operation, credential, fetcher }), /read-unavailable/);
  }
  for (const body of ['x'.repeat(131073), 'token=' + credential.accessToken, Buffer.from([0xff])])
    await assert.rejects(dispatchGitHubRead({ operation, credential, fetcher: async () => new Response(body) }));
  await assert.rejects(
    dispatchGitHubRead({
      operation: { kind: 'file.content', ...repo, path: 'a' },
      credential,
      fetcher: async (_url, init) =>
        init.headers.Accept === 'application/vnd.github+json'
          ? Response.json({ type: 'file', size: 10 })
          : new Response('x'.repeat(65537)),
    }),
    /read-limit/,
  );
  await assert.rejects(
    dispatchGitHubRead({
      operation,
      credential,
      fetcher: async url =>
        String(url).startsWith('https://api.github.com/')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://productionresultssa1.blob.core.windows.net/log' },
            })
          : new Response(null, { status: 401 }),
    }),
    /read-unavailable/,
  );
});

test('one deadline aborts stalled GraphQL and log HTTP bodies', async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': request.url === '/graphql' ? 'application/json' : 'text/plain' });
    response.write(request.url === '/graphql' ? '{' : 'unfinished');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const started = Date.now();
  await Promise.all(
    [
      { kind: 'project.read', owner: 'octocat', ownerType: 'user', number: 7 },
      { kind: 'actions.logs', ...repo, id: 7 },
    ].map(operation =>
      assert.rejects(
        dispatchGitHubRead({
          operation,
          credential,
          fetcher: (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init),
        }),
        /read-unavailable/,
      ),
    ),
  );
  assert.ok(Date.now() - started < 15000);
});

test('expanded reviewed MCP mappings send documented arguments and reject drift without API fallback', async () => {
  for (const [operation, expected] of [
    [
      { kind: 'file.search', query: 'repo:octocat/private x', page: 2, perPage: 3 },
      { name: 'search_code', arguments: { query: 'repo:octocat/private x', page: 2, perPage: 3 } },
    ],
    [
      { kind: 'branch.list', ...repo, page: 2, perPage: 3 },
      { name: 'list_branches', arguments: { ...repo, page: 2, perPage: 3 } },
    ],
    [
      { kind: 'file.read', ...repo, path: 'src/main.ts', ref: 'main' },
      { name: 'get_file_contents', arguments: { ...repo, path: 'src/main.ts', ref: 'main' } },
    ],
    [
      { kind: 'pull.diff', ...repo, number: 7 },
      { name: 'pull_request_read', arguments: { ...repo, pullNumber: 7, method: 'get_diff' } },
    ],
    [
      { kind: 'pull.reviews', ...repo, number: 7, page: 2, perPage: 3 },
      { name: 'pull_request_read', arguments: { ...repo, pullNumber: 7, method: 'get_reviews', page: 2, perPage: 3 } },
    ],
  ]) {
    const tool = {
      name: expected.name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(expected.arguments).map(([key, value]) => [key, { type: typeof value }]),
        ),
        additionalProperties: false,
      },
    };
    const bindings = [{ operation: operation.kind, name: tool.name, contractDigest: toolContractDigest(tool) }];
    let drift = false;
    const fetcher = async (url, init) => {
      assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
      assert.equal(new Headers(init.headers).get('X-MCP-Tools'), tool.name);
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'tools/call') assert.deepEqual(body.params, expected);
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : body.method === 'tools/list'
            ? { tools: [{ ...tool, name: drift ? 'changed' : tool.name }] }
            : { content: [{ type: 'text', text: 'Qualified private result' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    assert.deepEqual((await dispatchGitHubRead({ operation, credential, bindings, fetcher })).data, {
      content: [{ type: 'text', text: 'Qualified private result' }],
    });
    drift = true;
    await assert.rejects(dispatchGitHubRead({ operation, credential, bindings, fetcher }), /read-unqualified/);
    assert.throws(() => githubReadBindings({ GITHUB_MCP_READ_BINDINGS: JSON.stringify([...bindings, ...bindings]) }));
  }
});
