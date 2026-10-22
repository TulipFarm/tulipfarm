import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.mjs';
import { createAtlassianOperations } from '../dist/operations.js';
import { createAtlassianApproval } from '../dist/operation-approval.js';
import { toolContractDigest } from '../dist/mcp.js';

export const boardId = '1'.repeat(24);
export const listId = '2'.repeat(24);
export const cardId = '3'.repeat(24);
export const cloudId = '12345678-1234-4234-8234-123456789abc';
export const card = {
  id: cardId,
  idBoard: boardId,
  idList: listId,
  name: 'Exact title',
  desc: 'Exact description',
  closed: false,
  url: 'https://trello.com/c/example',
  due: null,
  dueComplete: false,
};
export const toolNames = {
  'jira.search': 'searchJiraIssuesUsingJql',
  'jira.read': 'getJiraIssue',
  'jira.create': 'createJiraIssue',
  'jira.update': 'editJiraIssue',
  'jira.delete': 'deleteJiraIssue',
  'confluence.search': 'searchConfluence',
  'confluence.read': 'getConfluenceContent',
  'confluence.create': 'createConfluenceContent',
  'confluence.update': 'updateConfluenceContent',
};
const tools = Object.values(toolNames).map(name => ({
  name,
  inputSchema: {
    type: 'object',
    properties: { cloudId: { type: 'string' } },
    required: ['cloudId'],
    additionalProperties: true,
  },
}));
export const bindings = Object.entries(toolNames).map(([operation, name]) => ({
  operation,
  name,
  contractDigest: toolContractDigest(tools.find(tool => tool.name === name)),
}));
export async function operationFixture() {
  const f = await accountFixture();
  const calls = [];
  let override;
  const fetcher = async (url, init) => {
    url = String(url);
    calls.push({ url, method: init.method, body: init.body });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-access-token');
    if (override) {
      const response = await override(url, init);
      if (response) return response;
    }
    if (url.includes('mcp.atlassian.com')) {
      const request = JSON.parse(init.body);
      if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : request.method === 'tools/list'
            ? { tools }
            : { content: [{ type: 'text', text: 'Untrusted provider text' }] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }
    if (url.includes('/wiki/api/v2/pages/'))
      return init.method === 'GET'
        ? Response.json({ id: '123', spaceId: '456', status: 'current' })
        : new Response(null, { status: 204 });
    if (url.includes('/lists/')) return Response.json({ id: listId, idBoard: boardId });
    if (url.includes('/search?')) return Response.json({ cards: [card] });
    if (init.method === 'DELETE') return Response.json({});
    return Response.json(card);
  };
  const makeOperations = (overrides = {}) =>
    createAtlassianOperations({ runtime: f.runtime, accounts: f.service, fetcher, bindings, ...overrides });
  const operations = makeOperations();
  const approve = createAtlassianApproval({
    runtime: f.runtime,
    resolveConfirmationCredential: async workspaceId => {
      const workspace = f.db.workspaces.find(value => value.id === workspaceId);
      assert.ok(workspace);
      return f.db.login(workspace, 'confirmation');
    },
  });
  const accountId = await f.connect();
  const source = await operations.createSource(f.one.id, f.member.userId, {
    name: 'My board',
    accountId,
    binding: { kind: 'trello', boardId },
  });
  const propose = (
    operation = { kind: 'card.create', listId, name: card.name, desc: card.desc },
    sourceId = source.id,
    commandId = randomUUID(),
  ) => operations.propose(f.one.id, f.member.userId, { commandId, sourceId, operation });
  const decide = (proposal, decision = 'approve') =>
    approve(f.one.id, f.member.userId, proposal.id, { digest: proposal.digest, decision });
  return {
    ...f,
    accountId,
    source,
    operations,
    makeOperations,
    approve,
    propose,
    decide,
    providerFetch: fetcher,
    providerCalls: calls,
    setProvider(value) {
      override = value;
    },
  };
}
