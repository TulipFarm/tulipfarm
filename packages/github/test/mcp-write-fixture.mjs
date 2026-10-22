import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { toolContractDigest } from '@tulipfarm/provider-mcp';

// Response shapes from github/github-mcp-server at 85b0399bf214f24f5028d9cedecdd020f646c822.
export const sha = 'a'.repeat(40);
const repo = { owner: 'octocat', repo: 'private' };
const pullRepo = { ...repo, repositoryId: 42 };
const pull = { ...pullRepo, pullNumber: 7, pullRequestId: 77 };
const issue = { ...repo, issueNumber: 7 };
const minimal = (id, path) => JSON.stringify({ id, url: `https://github.com/octocat/private/${path}` });
export const mcpWriteCases = [
  {
    operation: { kind: 'issue.create', ...repo, title: 'New', body: 'Description' },
    name: 'issue_write',
    args: { ...repo, method: 'create', title: 'New', body: 'Description' },
    text: minimal('88', 'issues/8'),
    receipt: { id: '88', number: 8 },
  },
  {
    operation: { kind: 'issue.update', ...issue, title: 'Edit', body: 'Updated' },
    name: 'issue_write',
    args: { ...repo, method: 'update', issue_number: 7, title: 'Edit', body: 'Updated' },
    text: minimal('77', 'issues/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: { kind: 'issue.comment', ...issue, body: 'Comment' },
    name: 'add_issue_comment',
    args: { ...repo, issue_number: 7, body: 'Comment' },
    text: minimal('99', 'issues/7#issuecomment-99'),
    receipt: { id: '99' },
  },
  {
    operation: { kind: 'issue.close', ...issue },
    name: 'issue_write',
    args: { ...repo, method: 'update', issue_number: 7, state: 'closed' },
    text: minimal('77', 'issues/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: { kind: 'issue.reopen', ...issue },
    name: 'issue_write',
    args: { ...repo, method: 'update', issue_number: 7, state: 'open' },
    text: minimal('77', 'issues/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: {
      kind: 'pull.create',
      ...pullRepo,
      title: 'New',
      body: 'Description',
      head: 'fix',
      base: 'main',
      draft: true,
    },
    name: 'create_pull_request',
    args: { ...repo, title: 'New', body: 'Description', head: 'fix', base: 'main', draft: true },
    text: minimal('88', 'pull/8'),
    receipt: { id: '88', number: 8 },
  },
  {
    operation: { kind: 'pull.update', ...pull, title: 'Edit', body: 'Updated', base: 'main' },
    name: 'update_pull_request',
    args: { ...repo, pullNumber: 7, title: 'Edit', body: 'Updated', base: 'main' },
    text: minimal('77', 'pull/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: { kind: 'pull.comment', ...pull, body: 'Comment' },
    name: 'add_issue_comment',
    args: { ...repo, issue_number: 7, body: 'Comment' },
    text: minimal('99', 'pull/7#issuecomment-99'),
    receipt: { id: '99' },
  },
  {
    operation: { kind: 'pull.review', ...pull, headSha: sha, body: 'Review', event: 'REQUEST_CHANGES' },
    name: 'pull_request_review_write',
    args: { ...repo, pullNumber: 7, method: 'create', commitID: sha, body: 'Review', event: 'REQUEST_CHANGES' },
    text: 'pull request review submitted successfully',
    receipt: { providerAcknowledged: true },
  },
  {
    operation: { kind: 'pull.request-reviewers', ...pull, reviewers: ['reviewer'], teamReviewers: ['engineers'] },
    name: 'request_pull_request_reviewers',
    args: { ...repo, pullNumber: 7, reviewers: ['reviewer', 'octocat/engineers'] },
    text: minimal('77', 'pull/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: { kind: 'pull.close', ...pull },
    name: 'update_pull_request',
    args: { ...repo, pullNumber: 7, state: 'closed' },
    text: minimal('77', 'pull/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: { kind: 'pull.reopen', ...pull },
    name: 'update_pull_request',
    args: { ...repo, pullNumber: 7, state: 'open' },
    text: minimal('77', 'pull/7'),
    receipt: { id: '77', number: 7 },
  },
  {
    operation: {
      kind: 'pull.merge',
      ...pull,
      headSha: sha,
      base: 'main',
      mergeMethod: 'squash',
      commitTitle: 'Ship',
      commitMessage: 'Reviewed',
    },
    name: 'merge_pull_request',
    args: {
      ...repo,
      pullNumber: 7,
      expectedHeadSha: sha,
      merge_method: 'squash',
      commit_title: 'Ship',
      commit_message: 'Reviewed',
    },
    text: JSON.stringify({ merged: true, sha, message: 'Pull Request successfully merged' }),
    receipt: { merged: true, sha },
  },
];

export async function mcpWriteFixture({
  item,
  result = { content: [{ type: 'text', text: item.text }] },
  outputSchema,
  effect = () => {},
  fetcher = fetch,
}) {
  const tool = {
    name: item.name,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(item.args).map(([key, value]) => [
          key,
          {
            type: Array.isArray(value) ? 'array' : typeof value,
            ...(Array.isArray(value) ? { items: { type: 'string' } } : {}),
          },
        ]),
      ),
      required: Object.keys(item.args),
      additionalProperties: false,
    },
    ...(outputSchema ? { outputSchema } : {}),
  };
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let value;
    if (body.method === 'initialize')
      value = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'official-shaped-fixture', version: '1' },
      };
    else if (body.method === 'tools/list') value = { tools: [tool] };
    else if (body.method === 'tools/call') {
      calls.push(body.params);
      effect(body.params);
      value = result;
    } else throw new Error(`Unexpected method ${body.method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    calls,
    tool,
    bindings: [{ operation: item.operation.kind, name: tool.name, contractDigest: toolContractDigest(tool) }],
    fetcher(url, init) {
      assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
      return fetcher(`http://127.0.0.1:${server.address().port}/mcp`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
