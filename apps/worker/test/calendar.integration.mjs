import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { createGitHubAccounts } from '../../../packages/github/src/accounts.ts';
import { createGitHubReads } from '../../../packages/github/src/reads.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';

for (const revoke of [false, true])
  test(`compiled no-MCP calendar flow ${revoke ? 'reauthorizes before the next model call' : 'captures the actual executed call and reloads provider cards'}`, async t => {
    const f = await googleFixture();
    t.after(() => f.close());
    await f.connect();
    const values = {
      ANTHROPIC_API_KEY: 'synthetic-model-key',
      INTEGRATION_CREDENTIAL_KEY_ID: 'test',
      INTEGRATION_CREDENTIAL_KEY: 'ab'.repeat(32),
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const event = {
      id: 'provider-meeting',
      summary: 'Provider-only calendar title',
      start: { dateTime: '2026-11-01T09:00:00Z' },
      end: { dateTime: '2026-11-01T10:00:00Z' },
      hangoutLink: 'https://meet.google.com/actual',
    };
    let modelCalls = 0,
      googleCalls = 0,
      freshContext = false;
    const decision = input =>
      Response.json(
        anthropicChat(input, {
          model: 'claude-sonnet',
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      );
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (String(url).startsWith('https://www.googleapis.com/calendar/v3/')) {
        googleCalls++;
        return Response.json({ items: [event] });
      }
      assert.equal(new URL(url).hostname, 'api.anthropic.com');
      if (isCompletionRequest(JSON.parse(init.body))) return Response.json(completionReply('anthropic'));
      if (isTitleRequest(JSON.parse(init.body)))
        return Response.json(anthropicText('Provider-only calendar title', { model: 'claude-sonnet' }));
      modelCalls++;
      if (freshContext) {
        assert.equal(init.body.includes('Provider-only calendar title'), false);
        assert.equal(init.body.includes('List calendar events'), false);
        assert.match(init.body, /Start fresh without my old calendar/);
        return decision({ kind: 'answer', text: 'Fresh context is ready.' });
      }
      if (modelCalls === 1)
        return decision({
          kind: 'tool',
          text: 'Reading your calendar',
          call: {
            tool: 'google.read',
            operation: {
              kind: 'calendar.events.list',
              calendarId: 'primary',
              singleEvents: true,
              orderBy: 'startTime',
            },
          },
        });
      assert.match(init.body, /Provider-only calendar title/);
      assert.equal(revoke, false, 'revoked provider content never reaches the second model request');
      if (modelCalls === 2)
        return decision({
          kind: 'tool',
          text: 'Finding records for Provider-only calendar title',
          call: { tool: 'tables.definitions' },
        });
      return decision({ kind: 'answer', text: 'Provider-only calendar title is scheduled.' });
    });
    const runtime = revoke
      ? {
          transaction: async (...args) => {
            const result = await f.runtime.transaction(...args);
            if (
              googleCalls &&
              !runtime.revoked &&
              (
                await f.db.platform.query(
                  `SELECT 1 FROM ${f.table('tf_conversation_execution_steps')} WHERE output IS NOT NULL`,
                )
              ).rowCount
            ) {
              runtime.revoked = true;
              await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=generation+1`);
            }
            return result;
          },
          revoked: false,
        }
      : f.runtime;
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(f.workspace.id, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'List calendar events' }],
    });
    const result = await createConversationActivities(
      runtime,
      undefined,
      undefined,
      undefined,
    ).processConversationReply({
      workspaceId: f.workspace.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    assert.equal(result, revoke ? 'retry' : 'completed');
    assert.equal(googleCalls, 1);
    assert.equal(modelCalls, revoke ? 1 : 3);
    const history = await f.store.history(f.workspace.id, f.member.userId, chatId);
    if (revoke) {
      assert.equal(history.messages[0].calendarResults[0].kind, 'unavailable');
      assert.equal(JSON.stringify(history).includes('Provider-only calendar title'), false);
    } else {
      assert.equal(history.messages[0].calendarResults[0].events[0].title, 'Provider-only calendar title');
      assert.equal(history.messages[1].parts[0].text, 'Provider-only calendar title is scheduled.');
    }
    assert.equal((await f.store.read(f.workspace.id, f.member.userId, chatId)).title, 'List calendar events');
    if (!revoke) {
      assert.deepEqual(
        history.messages[0].tools.map(tool => [tool.tool, tool.status, tool.activity]),
        [
          ['google.read', 'completed', 'Reading your Google Calendar data'],
          ['tables.definitions', 'completed', null],
        ],
      );
      const accounts = createGitHubAccounts({
        runtime: f.runtime,
        configuration: {
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
          redirectUri: 'http://127.0.0.1/github/callback',
          scopes: ['repo', 'read:user'],
        },
        keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
        fetcher: async url =>
          String(url).endsWith('/access_token')
            ? Response.json({ access_token: 'synthetic-access-token', token_type: 'bearer', scope: 'repo,read:user' })
            : Response.json({ id: 123, login: 'octocat' }),
      });
      const started = await accounts.begin(f.workspace.id, f.member.userId, 'test-session');
      await accounts.complete(
        { code: 'fixture-code', state: new URL(started.url).searchParams.get('state') },
        'test-session',
        f.member.userId,
      );
      const reads = createGitHubReads({ runtime: f.runtime, accounts });
      await reads.select(f.workspace.id, f.member.userId, chatId, { accountId: started.accountId, expectedVersion: 0 });
      await reads.select(f.workspace.id, f.member.userId, chatId, { accountId: null, expectedVersion: 1 });
      await f.service.disconnect(f.workspace.id, f.member.userId);
      const reloaded = await f.store.history(f.workspace.id, f.member.userId, chatId);
      assert.equal(reloaded.messages[0].calendarResults[0].kind, 'unavailable');
      assert.equal(JSON.stringify(reloaded).includes('Provider-only calendar title'), false);
      freshContext = true;
      const fresh = await f.store.send(f.workspace.id, f.member.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Start fresh without my old calendar' }],
      });
      assert.equal(
        await createConversationActivities(f.runtime, undefined, undefined, undefined).processConversationReply({
          workspaceId: f.workspace.id,
          conversationId: chatId,
          turnId: fresh.turnId,
          generation: 0,
        }),
        'completed',
      );
      assert.equal(modelCalls, 4);
      assert.equal(
        (await f.store.history(f.workspace.id, f.member.userId, chatId)).messages.at(-1).parts[0].text,
        'Fresh context is ready.',
      );
    }
  });
