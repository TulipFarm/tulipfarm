import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools } from '@tulipfarm/agents/tools';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { secretsServices } from '../src/secrets-composition.ts';
import { anthropicTools, anthropicText } from './native-chat-fixture.mjs';
import { selectReply } from '../../../packages/agents/test/native-fixture.mjs';

const env = {
  SECRETS_ENABLED: 'true',
  INTEGRATION_CREDENTIAL_KEY_ID: 'test',
  INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
};
const route = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' };
const request = {
  tool: 'secrets.request',
  purpose: 'Read the forecast from the weather API',
  fields: [{ id: 'key', label: 'API key', kind: 'api-key', placement: { kind: 'header', name: 'X-Api-Key' } }],
  destinations: [{ kind: 'host', host: 'api.weather.example' }],
};

test(
  'secrets.request pauses the chat on a private form and resumes it with references only',
  { timeout: 60000 },
  async t => {
    const previous = process.env.SECRETS_ENABLED;
    process.env.SECRETS_ENABLED = 'true';
    t.after(() =>
      previous === undefined ? delete process.env.SECRETS_ENABLED : (process.env.SECRETS_ENABLED = previous),
    );
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const secrets = secretsServices(f.runtime, env);
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
            false,
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            sources,
            call,
            activity,
          ),
        undefined,
        undefined,
        false,
        null,
        { priorCalls: input.priorCalls, sources: () => [] },
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
      parts: [{ kind: 'text', text: 'What is the forecast? Use my weather API.' }],
    });
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    responses = [
      anthropicTools([{ tool: 'tools.search', query: 'secrets' }]),
      anthropicTools([{ ...request, destinations: [{ kind: 'host', host: 'api.weather.example/path' }] }]),
      anthropicTools([request]),
    ];
    assert.equal(await executor(f.runtime).process(work), 'idle');
    assert.equal(responses.length, 0);
    assert.match(JSON.stringify(calls.at(-1)), /invalid-destination/);

    const history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages[0].turn.status, 'waiting');
    const pending = (
      await f.db.platform.query(
        `SELECT s.id, s.status, s.origin, r.answer_schema FROM ${f.table('tf_secret_requests')} s
       JOIN ${f.table('tf_conversation_requests')} r ON r.id = (s.origin->>'conversationRequestId')::uuid`,
      )
    ).rows;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'waiting');
    assert.deepEqual(pending[0].answer_schema, { kind: 'secrets', secretRequestId: pending[0].id });
    assert.equal(pending[0].origin.conversationId, chatId);

    const value = `sk-${randomUUID()}`;
    const provided = await secrets.requests.submit(w.id, w.userId, pending[0].id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      fields: [{ fieldId: 'key', value: { value }, lifetime: 'conversation' }],
    });
    assert.equal(provided.status, 'provided');

    responses = [
      anthropicTools([{ tool: 'secrets.list' }]),
      anthropicText('I have a reference to your weather API key.'),
      selectReply('anthropic', { status: 'blocked', reason: 'No API call tool is available yet.' }),
    ];
    assert.equal(await executor(f.runtime).process({ ...work, generation: 1 }), 'completed');
    assert.equal(responses.length, 0);
    const replay = JSON.stringify(calls.slice(-3));
    assert.match(replay, /never see values/);
    assert.match(replay, /referenceId/);
    assert.match(replay, /x-api-key/);
    assert.equal(replay.includes(value), false);
    const stored = JSON.stringify(
      (
        await f.db.platform.query(
          `SELECT s.output, c.tool, c.status FROM ${f.table('tf_conversation_execution_steps')} s
         JOIN ${f.table('tf_conversation_tool_calls')} c ON c.id = s.call_id WHERE s.turn_id = $1 ORDER BY c.sequence`,
          [sent.turnId],
        )
      ).rows,
    );
    assert.equal(stored.includes(value), false);
    assert.match(stored, /awaiting-input/);
  },
);
