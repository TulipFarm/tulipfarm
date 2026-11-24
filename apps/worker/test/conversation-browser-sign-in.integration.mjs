import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools, isExternalTool } from '@tulipfarm/agents/tools';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { chatBrowserSecrets, secretsServices } from '../src/secrets-composition.ts';
import { anthropicTools, anthropicText } from './native-chat-fixture.mjs';
import { selectReply } from '../../../packages/agents/test/native-fixture.mjs';

const env = {
  INTEGRATION_CREDENTIAL_KEY_ID: 'test',
  INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
};
const route = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' };
const request = {
  tool: 'secrets.request',
  purpose: 'Sign in to Example',
  fields: [{ id: 'login', label: 'Example login', kind: 'username-password', placement: { kind: 'browser' } }],
  destinations: [{ kind: 'host', host: 'accounts.example.com' }],
};

test('browser.signIn types a secret the member gave in this chat and records its use', { timeout: 60000 }, async t => {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => (previous === undefined ? delete process.env[name] : (process.env[name] = previous)));
  }
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const secrets = secretsServices(f.runtime, env);
  const page = { sessionId: 's', url: 'https://accounts.example.com/login', title: 'Sign in' };
  const typed = [];
  const client = {
    state: async () => ({ ...page, controller: 'agent', needsPerson: null }),
    open: async () => ({ ...page, controller: 'agent', needsPerson: null }),
    typeSecret: async (_id, input) => {
      typed.push(input);
      return {
        state: { ...page, title: 'Welcome', controller: 'agent', needsPerson: null },
        snapshot: '- heading "Welcome" [ref=e9]',
        truncated: false,
        screenshot: 'AAAA',
      };
    },
  };
  const browser = { client, imageInput: false, secrets: chatBrowserSecrets(secrets) };
  let responses = [];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    assert.ok(responses.length, 'no model call while waiting');
    return Response.json(responses.shift());
  });
  const reply = input =>
    respondToConversation(
      route,
      input.messages,
      (call, sources, activity) =>
        input.executeTool(
          call.tool,
          isExternalTool(call.tool),
          context => createChatTools(context.runtime, { browser }).invokeWithSources(context, call),
          sources,
          call,
          activity,
        ),
      undefined,
      undefined,
      false,
      null,
      { priorCalls: input.priorCalls, sources: () => [], browser: true },
    );
  const executor = runtime =>
    createConversationExecutor(
      runtime,
      reply,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      secrets.chat,
    );

  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    model: 'claude-sonnet',
    parts: [{ kind: 'text', text: 'Sign in to Example for me.' }],
  });
  const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
  responses = [anthropicTools([{ tool: 'tools.search', query: 'secrets' }]), anthropicTools([request])];
  assert.equal(await executor(f.runtime).process(work), 'idle');
  const [pending] = (await f.db.platform.query(`SELECT id FROM ${f.table('tf_secret_requests')}`)).rows;
  const login = { username: `ada-${randomUUID()}@example.com`, password: `pw-${randomUUID()}` };
  const provided = await secrets.requests.submit(w.id, w.userId, pending.id, {
    requestId: randomUUID(),
    expectedRevision: 1,
    fields: [{ fieldId: 'login', value: login, lifetime: 'conversation' }],
  });
  assert.equal(provided.status, 'provided');
  const reference = provided.references[0].referenceId;

  responses = [
    anthropicTools([{ tool: 'browser.signIn', secret: reference, username: 'e1', password: 'e2', submit: 'e3' }]),
    anthropicText('You are signed in to Example.'),
    selectReply('anthropic', { status: 'done' }),
  ];
  assert.equal(await executor(f.runtime).process({ ...work, generation: 1 }), 'completed');
  assert.deepEqual(typed, [
    {
      hosts: ['accounts.example.com'],
      fields: [
        { ref: 'e1', kind: 'username', value: login.username },
        { ref: 'e2', kind: 'password', value: login.password },
      ],
      submit: 'e3',
    },
  ]);
  const replay = JSON.stringify(calls);
  assert.match(replay, /Welcome/);
  assert.equal(replay.includes(login.username) || replay.includes(login.password), false);
  const used = (
    await f.db.platform.query(`SELECT details FROM ${f.table('tf_secret_events')} WHERE operation = 'used'`)
  ).rows;
  assert.deepEqual(
    used.map(row => [row.details.tool, row.details.url]),
    [['browser.signIn', page.url]],
  );
  const stored = JSON.stringify(
    (await f.db.platform.query(`SELECT output FROM ${f.table('tf_conversation_execution_steps')}`)).rows,
  );
  assert.equal(stored.includes(login.password), false);
});
