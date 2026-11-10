import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createChatTools } from '../src/tools.ts';

const githubId = randomUUID(),
  goneId = randomUUID(),
  sharedId = randomUUID(),
  trelloId = randomUUID();
const connections = {
  google: {
    availability: () => ({ configured: true }),
    status: async () => ({
      status: 'connected',
      email: 'ada@example.com',
      scopes: [...googleAppScopes.gmail, ...googleAppScopes.calendar],
      accessToken: 'never-shown',
    }),
  },
  github: {
    list: async () => ({
      configured: true,
      accounts: [
        { id: githubId, state: 'active', identity: { login: 'ada' }, token: 'never-shown' },
        { id: goneId, state: 'disconnected', identity: { login: 'old' } },
      ],
    }),
  },
  atlassian: {
    list: async () => ({
      accounts: [
        {
          id: sharedId,
          protocol: 'atlassian-mcp',
          ownership: 'business',
          state: 'reconnect-required',
          identity: { label: 'Acme' },
          resources: [{ name: 'acme.atlassian.net' }],
          capabilities: { manage: false },
        },
        {
          id: trelloId,
          protocol: 'trello',
          ownership: 'personal',
          state: 'active',
          identity: { label: 'Ada' },
          resources: [],
          capabilities: { manage: true },
        },
      ],
      providers: [
        { protocol: 'atlassian-mcp', configured: true },
        { protocol: 'trello', configured: true },
      ],
    }),
  },
};

async function setup(t, services = connections) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const chats = createConversations(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const tool = async function (call) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Manage my integrations.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (
        await executeTool(
          call.tool,
          false,
          context => createChatTools(context.runtime, { connections: services }).invokeWithSources(context, call),
          [],
          call,
        )
      ).result;
      return { text: 'Use the card.', sources: [] };
    });
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return output;
  };
  tool.cards = async () =>
    (await chats.history(w.id, w.userId, chatId)).messages.flatMap(message =>
      message.tools.flatMap(item => (item.integration ? [item.integration] : [])),
    );
  return tool;
}

test('chat lists connections without credentials and offers connect and disconnect cards', async t => {
  const tool = await setup(t);
  const listed = await tool({ tool: 'integrations.list' });
  assert.doesNotMatch(JSON.stringify(listed), /never-shown|token/i);
  assert.deepEqual(
    listed.connections.map(c => [c.connectionId, c.provider, c.account, c.state, c.canDisconnect]),
    [
      ['google', 'google', 'ada@example.com', 'connected', true],
      [`github:${githubId}`, 'github', 'ada', 'connected', true],
      [`atlassian:${sharedId}`, 'atlassian', 'Acme', 'reconnect-required', false],
      [`atlassian:${trelloId}`, 'trello', 'Ada', 'connected', true],
    ],
  );
  assert.deepEqual(listed.connections[0].apps, ['gmail', 'google-calendar']);
  assert.deepEqual(Object.fromEntries(listed.apps.map(a => [a.app, a.connected])), {
    gmail: true,
    'google-calendar': true,
    'google-drive': false,
    'google-sheets': false,
    'google-docs': false,
    'google-slides': false,
    'github-personal': true,
    jira: false,
    confluence: false,
    trello: true,
  });

  assert.equal((await tool({ tool: 'integrations.connect', app: 'gmail' })).error, 'already-connected');
  assert.deepEqual(
    { ...(await tool({ tool: 'integrations.connect', app: 'google-drive' })), instruction: undefined },
    { status: 'connect-card', app: 'google-drive', name: 'Google Drive', instruction: undefined },
  );
  assert.equal((await tool({ tool: 'integrations.connect', app: 'jira' })).status, 'connect-card');

  assert.equal((await tool({ tool: 'integrations.disconnect', connectionId: `github:${goneId}` })).error, 'not-found');
  assert.equal(
    (await tool({ tool: 'integrations.disconnect', connectionId: `atlassian:${sharedId}` })).error,
    'not-allowed',
  );
  const review = await tool({ tool: 'integrations.disconnect', connectionId: `github:${githubId}` });
  assert.equal(review.status, 'review-required');
  assert.equal(review.connection.account, 'ada');
});

test('chat finds remote MCP servers and offers a personal setup card', async t => {
  const entry = (name, endpoint, extra = {}) => ({
    id: `${name}@1:0`,
    name,
    version: '1',
    title: name,
    description: 'd'.repeat(400),
    endpoint,
    status: 'active',
    compatibility: 'unverified',
    authentication: 'unknown',
    ...extra,
  });
  const queries = [];
  const tool = await setup(t, {
    ...connections,
    mcp: {
      search: async query => {
        queries.push(query);
        if (query === 'broken') throw new Error('registry down');
        return [
          entry('io.github.PostHog/mcp', 'https://mcp.posthog.com/mcp'),
          entry('example/old', 'https://old.example.com/mcp', { status: 'deprecated' }),
          entry('example/tenant', 'https://{tenant}.example.com/mcp', { compatibility: 'template-required' }),
        ];
      },
    },
  });
  const found = await tool({ tool: 'integrations.mcp.search', query: 'posthog' });
  assert.deepEqual(queries, ['posthog']);
  assert.deepEqual(
    found.servers.map(server => [server.registryName, server.endpoint, server.needsValues, server.description.length]),
    [
      ['io.github.PostHog/mcp', 'https://mcp.posthog.com/mcp', false, 300],
      ['example/tenant', 'https://{tenant}.example.com/mcp', true, 300],
    ],
  );
  assert.equal((await tool({ tool: 'integrations.mcp.search', query: 'broken' })).error, 'registry-unavailable');

  assert.deepEqual(
    {
      ...(await tool({
        tool: 'integrations.mcp.connect',
        name: 'PostHog',
        endpoint: 'https://mcp.posthog.com/mcp',
        authentication: 'secrets',
      })),
      instruction: undefined,
    },
    {
      status: 'mcp-connect-card',
      name: 'PostHog',
      endpoint: 'https://mcp.posthog.com/mcp',
      authentication: 'secrets',
      instruction: undefined,
    },
  );
  assert.deepEqual(await tool.cards(), [
    { action: 'mcp', name: 'PostHog', endpoint: 'https://mcp.posthog.com/mcp', authentication: 'secrets' },
  ]);
  for (const endpoint of ['https://{tenant}.example.com/mcp', 'http://mcp.posthog.com/mcp', 'https://127.0.0.1/mcp'])
    assert.equal(
      (await tool({ tool: 'integrations.mcp.connect', name: 'Bad', endpoint, authentication: 'none' })).error,
      'endpoint-denied',
      endpoint,
    );
});

test('chat MCP tools explain when custom MCP connections are off', async t => {
  const tool = await setup(t);
  assert.equal((await tool({ tool: 'integrations.mcp.search', query: 'posthog' })).error, 'mcp-unavailable');
  assert.equal(
    (
      await tool({
        tool: 'integrations.mcp.connect',
        name: 'PostHog',
        endpoint: 'https://mcp.posthog.com/mcp',
        authentication: 'oauth',
      })
    ).error,
    'mcp-unavailable',
  );
});
