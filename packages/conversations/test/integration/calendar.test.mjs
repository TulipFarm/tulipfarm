import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleFixture } from '../../../google-workspace/test/fixture.mjs';
import { createGoogleOperations } from '../../../google-workspace/src/operations.ts';
import { createChatTools } from '../../../agents/src/tools.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createConversations } from '../../src/index.ts';
import { createConversationTitles } from '../../src/titles.ts';
import { inferChatTitle } from '../../../agents/src/inference.ts';
import { respondToConversation } from '../../../../apps/worker/src/conversation-responder.ts';
import {
  completionReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  use,
} from '../../../agents/test/native-fixture.mjs';

for (const finish of ['completed', 'interrupted', 'revoked-before-final'])
  test(`Google-derived activity is concealed during execution and on ${finish} reload`, async () => {
    const f = await setup();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let pending;
    try {
      const operation = { kind: 'calendar.events.list', calendarId: 'primary' };
      const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        await executeTool(
          'google.read',
          true,
          context => f.invoke(context, operation),
          [],
          { tool: 'google.read', operation },
          'Reading calendar',
        );
        await executeTool(
          'tables.definitions',
          true,
          async () => {
            entered.resolve();
            await release.promise;
            return { result: [], sources: [] };
          },
          [],
          { tool: 'tables.definitions' },
          'Finding records for Private provider meeting',
        );
        if (finish === 'interrupted') throw new Error('lost final response');
        return { text: 'Private provider meeting', sources: [] };
      });
      pending = executor.process(await f.send('Read my calendar'));
      await entered.promise;
      const running = await f.history();
      assert.deepEqual(
        running.messages[0].tools.map(tool => [tool.tool, tool.status, tool.activity]),
        [
          ['google.read', 'completed', 'Reading your Google Calendar data'],
          ['tables.definitions', 'running', null],
        ],
      );
      if (finish === 'revoked-before-final') {
        await f.service.disconnect(f.workspace.id, f.member.userId);
        assert.equal(JSON.stringify(await f.history()).includes('Private provider meeting'), false);
      }
      release.resolve();
      assert.equal(
        await pending,
        { completed: 'completed', interrupted: 'retry', 'revoked-before-final': 'failed' }[finish],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_tool_calls')} SET activity='Finding records for Private provider meeting' WHERE tool='tables.definitions'`,
      );
      if (finish !== 'revoked-before-final') await f.service.disconnect(f.workspace.id, f.member.userId);
      const restarted = f.createRuntime();
      try {
        const history = await createConversations(restarted).history(f.workspace.id, f.member.userId, f.chatId);
        assert.equal(history.messages[0].calendarResults[0].kind, 'unavailable');
        assert.equal(history.messages[0].tools.length, 2);
        assert.equal(JSON.stringify(history).includes('Private provider meeting'), false);
      } finally {
        await restarted.close();
      }
    } finally {
      release.resolve();
      await pending;
      await f.close();
    }
  });

const event = {
  id: 'meeting1',
  summary: 'Private provider meeting',
  start: { dateTime: '2026-10-05T09:00:00Z' },
  end: { dateTime: '2026-10-05T10:00:00Z' },
  hangoutLink: 'https://meet.google.com/private',
};
async function setup() {
  const f = await googleFixture();
  const status = await f.connect();
  const chatId = randomUUID();
  await f.store.create(f.workspace.id, f.member.userId, { chatId, commandId: randomUUID() });
  const send = async text => {
    const sent = await f.store.send(f.workspace.id, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
    });
    return { workspaceId: f.workspace.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
  };
  const invoke = (context, operation) =>
    createChatTools(context.runtime, {
      google: runtime =>
        createGoogleOperations({
          runtime,
          integrations: f.service,
          fetcher: async () =>
            Response.json(operation.kind.endsWith('.get') ? event : { items: [event], nextPageToken: 'more' }),
        }),
    }).invokeWithSources(context, { tool: 'google.read', operation });
  return {
    ...f,
    status,
    chatId,
    send,
    invoke,
    history: () => f.store.history(f.workspace.id, f.member.userId, chatId),
  };
}

test('a user-message title persists after a Google read without exposing provider content in the title', async t => {
  const f = await setup();
  try {
    let replyCalls = 0,
      titleCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      if (init.body.includes('Write a title for a new chat')) {
        titleCalls++;
        assert.match(init.body, /Read my calendar/);
        assert.doesNotMatch(init.body, /Private provider meeting|meet.google.com/);
        return Response.json(nativeReply('anthropic', { text: 'Calendar review' }));
      }
      if (replyCalls++ === 0)
        return Response.json(
          nativeReply('anthropic', {
            calls: [use('google.read', { operation: { kind: 'calendar.events.list', calendarId: 'primary' } })],
          }),
        );
      return Response.json(nativeReply('anthropic', { text: 'Private provider meeting is on Monday.' }));
    });
    const executor = createConversationExecutor(f.runtime, input =>
      respondToConversation(
        nativeRoutes.anthropic,
        input.messages,
        (call, sources, activity) =>
          input.executeTool(call.tool, true, context => f.invoke(context, call.operation), sources, call, activity),
        undefined,
        undefined,
        false,
        input.timeZone,
        undefined,
        input.retainedSources,
        input.sourceMessages,
      ),
    );
    const work = await f.send('Read my calendar');
    const delivered = await executor.processReply(work);
    assert.deepEqual(delivered, { outcome: 'completed', title: { titleRevision: 1 } });
    assert.equal(titleCalls, 0);
    const titles = createConversationTitles(f.runtime);
    const titleWork = { ...work, ...delivered.title };
    const request = await titles.request(titleWork);
    assert.equal(await titles.save(titleWork, await inferChatTitle(nativeRoutes.anthropic, request.text)), 'generated');
    assert.equal(titleCalls, 1);
    const saved = await f.store.read(f.workspace.id, f.member.userId, f.chatId);
    assert.equal(saved.title, 'Calendar review');
    assert.equal(saved.titleRevision, 2);
    assert.equal(
      (await f.store.list(f.workspace.id, f.member.userId)).chats.find(chat => chat.id === f.chatId).title,
      'Calendar review',
    );
    await f.service.disconnect(f.workspace.id, f.member.userId);
    assert.equal(JSON.stringify(await f.history()).includes('Private provider meeting'), false);
    assert.equal((await f.store.read(f.workspace.id, f.member.userId, f.chatId)).title, 'Calendar review');
  } finally {
    await f.close();
  }
});

test('real Google reads persist without MCP, reload exact cards, and revoke cards, prose and next model context', async () => {
  const f = await setup();
  try {
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      for (const operation of [
        { kind: 'calendar.events.list', calendarId: 'primary' },
        { kind: 'calendar.events.get', calendarId: 'primary', eventId: 'meeting1' },
      ]) {
        await executeTool('google.read', true, context => f.invoke(context, operation), [], {
          tool: 'google.read',
          operation,
        });
      }
      return { text: 'Private provider meeting is on Monday.', sources: [] };
    });
    assert.equal(await executor.process(await f.send('Read my calendar')), 'completed');
    const restarted = f.createRuntime();
    try {
      const history = await createConversations(restarted).history(f.workspace.id, f.member.userId, f.chatId);
      assert.deepEqual(
        history.messages[0].calendarResults.map(result => [
          result.kind,
          result.events[0].title,
          result.events[0].time.startsAt,
          result.events[0].joinUrl,
          result.continuation,
        ]),
        [
          [
            'events',
            'Private provider meeting',
            '2026-10-05T09:00:00Z',
            'https://meet.google.com/private',
            'more-available',
          ],
          ['events', 'Private provider meeting', '2026-10-05T09:00:00Z', 'https://meet.google.com/private', 'complete'],
        ],
      );
      assert.equal((await f.store.read(f.workspace.id, f.member.userId, f.chatId)).title, 'Read my calendar');
    } finally {
      await restarted.close();
    }
    for (const [column, value] of [
      ['generation', f.status.generation + 1],
      ['account_id', 'another-account'],
      ['scopes', ['openid']],
      ['membership_id', f.admin.membershipId],
    ]) {
      await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET ${column}=$1`, [value]);
      const history = await f.history();
      assert.deepEqual(
        history.messages[0].calendarResults.map(result => result.kind),
        ['unavailable', 'unavailable'],
      );
      assert.equal(JSON.stringify(history).includes('Private provider meeting'), false);
      assert.equal(JSON.stringify(history).includes('meet.google.com'), false);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_google_integrations')} SET generation=$1,account_id=$2,scopes=$3,membership_id=$4,status='connected'`,
        [f.status.generation, f.status.accountId, f.status.scopes, f.member.membershipId],
      );
    }
    await f.service.disconnect(f.workspace.id, f.member.userId);
    let consumed = false;
    const next = createConversationExecutor(f.runtime, async () => {
      consumed = true;
      return 'leaked';
    });
    await next.process(await f.send('What was that meeting?'));
    assert.equal(consumed, false);
    assert.equal(JSON.stringify(await f.history()).includes('Private provider meeting'), false);
  } finally {
    await f.close();
  }
});

test('calendar capture preserves no-MCP interruption recovery and rejects malformed or unsourced output', async () => {
  const f = await setup();
  try {
    let calls = 0;
    const operation = { kind: 'calendar.events.list', calendarId: 'primary' };
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      calls++;
      await executeTool('google.read', true, context => f.invoke(context, operation), [], {
        tool: 'google.read',
        operation,
      });
      throw new Error('lost model reply');
    });
    const work = await f.send('Read meetings');
    assert.equal(await executor.process(work), 'retry');
    assert.equal((await f.history()).messages[0].calendarResults[0].events[0].title, 'Private provider meeting');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [work.turnId],
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'stale');
    assert.equal(calls, 1);
    const stopped = await f.history();
    assert.equal(stopped.messages.length, 1);
    assert.equal(stopped.messages[0].turn.status, 'failed');
    assert.equal(stopped.messages[0].turn.errorCode, 'transient-failure');
    assert.equal(JSON.stringify(stopped).includes('google.read'), true, 'the receipt row stays');
    assert.equal(JSON.stringify(stopped).includes('did not repeat'), false);
    const retried = await f.store.retry(f.workspace.id, f.member.userId, work.conversationId, work.turnId, {
      commandId: randomUUID(),
      expectedGeneration: stopped.messages[0].turn.generation,
    });
    let resumed;
    const resume = createConversationExecutor(f.runtime, async input => {
      resumed = input;
      return 'Your meetings are listed above.';
    });
    assert.equal(await resume.process({ ...work, generation: retried.generation }), 'completed');
    assert.equal(calls, 1);
    assert.deepEqual(resumed.priorToolCalls, [{ tool: 'google.read', operation }]);
    assert.ok(resumed.messages.some(message => message.text.includes('Do not repeat this call. Untrusted data:')));
    const saved = (
      await f.db.platform.query(`SELECT call_id,output FROM ${f.table('tf_conversation_execution_steps')}`)
    ).rows[0];
    for (const output of [
      {
        result: { provider: 'google-workspace', untrusted: true, error: 'provider-failed' },
        sources: saved.output.sources,
      },
      { ...saved.output, sources: [] },
      {
        ...saved.output,
        result: {
          ...saved.output.result,
          data: { untrusted: true, data: { items: [{ ...event, start: { dateTime: 'invalid' } }] } },
        },
      },
    ]) {
      await f.db.platform.query(`UPDATE ${f.table('tf_conversation_execution_steps')} SET output=$1 WHERE call_id=$2`, [
        output,
        saved.call_id,
      ]);
      assert.equal((await f.history()).messages[0].calendarResults[0].kind, 'unavailable');
    }
  } finally {
    await f.close();
  }
});

test('a fenced calendar completion publishes neither output nor a card', async () => {
  const f = await setup();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let pending;
  try {
    const operation = { kind: 'calendar.events.list', calendarId: 'primary' };
    const work = await f.send('Read calendar');
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool(
        'google.read',
        true,
        async context => {
          const result = await f.invoke(context, operation);
          entered.resolve();
          await release.promise;
          return result;
        },
        [],
        { tool: 'google.read', operation },
      );
      return 'Should not publish';
    });
    pending = executor.process(work);
    await entered.promise;
    await f.store.cancel(f.workspace.id, f.member.userId, f.chatId, work.turnId, {
      commandId: randomUUID(),
      expectedGeneration: 0,
    });
    release.resolve();
    assert.equal(await pending, 'stale');
    const history = await f.history();
    assert.equal(history.messages[0].turn.status, 'cancelled');
    assert.deepEqual(history.messages[0].calendarResults, []);
    assert.equal(
      (await f.db.platform.query(`SELECT output FROM ${f.table('tf_conversation_execution_steps')}`)).rows[0].output,
      null,
    );
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});

test('revocation between a completed calendar tool and final answer blocks publication', async () => {
  const f = await setup();
  try {
    const operation = { kind: 'calendar.events.list', calendarId: 'primary' };
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('google.read', true, context => f.invoke(context, operation), [], {
        tool: 'google.read',
        operation,
      });
      await f.service.disconnect(f.workspace.id, f.member.userId);
      return { text: 'Private provider meeting', sources: [] };
    });
    assert.equal(await executor.process(await f.send('Read calendar')), 'failed');
    const history = await f.history();
    assert.deepEqual(
      history.messages.map(message => message.author),
      ['human'],
    );
    assert.equal(history.messages[0].calendarResults[0].kind, 'unavailable');
    assert.equal(JSON.stringify(history).includes('Private provider meeting'), false);
  } finally {
    await f.close();
  }
});

test('model lookalikes and proposal outputs never become calendar cards', async () => {
  const f = await setup();
  try {
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool(
        'google.propose',
        false,
        async () => ({ result: { provider: 'google-workspace', data: { items: [event] } }, sources: [] }),
        [],
        { tool: 'google.propose', operation: { kind: 'calendar.events.list', calendarId: 'primary' } },
      );
      return JSON.stringify({ calendarResults: [{ kind: 'events', events: [event] }] });
    });
    assert.equal(await executor.process(await f.send('Propose a meeting')), 'completed');
    const history = await f.history();
    assert.match(history.messages[1].parts[0].text, /calendarResults/);
    assert.deepEqual(
      history.messages.map(message => message.calendarResults),
      [[], []],
    );
  } finally {
    await f.close();
  }
});

test('MCP-enabled recovery retains calendar snapshots and replays completed outputs without rereading Google', async () => {
  const f = await setup();
  try {
    let attempts = 0,
      googleReads = 0;
    const operation = { kind: 'calendar.events.list', calendarId: 'primary' };
    const executor = createConversationExecutor(
      f.runtime,
      async ({ executeTool, messages }) => {
        if (++attempts === 1) {
          await executeTool(
            'mcp.describe',
            false,
            async () => ({ result: { kind: 'catalog', tools: [] }, sources: [] }),
            [],
            { tool: 'mcp.describe', handle: 'synthetic' },
          );
          await executeTool(
            'google.read',
            true,
            context => {
              googleReads++;
              return f.invoke(context, operation);
            },
            [],
            { tool: 'google.read', operation },
          );
          throw new Error('lost answer');
        }
        assert.match(JSON.stringify(messages), /Private provider meeting/);
        assert.match(JSON.stringify(messages), /Do not repeat/);
        return 'Recovered the completed calendar read';
      },
      undefined,
      undefined,
      async () => assert.fail('No pending MCP action'),
    );
    const work = await f.send('Read calendar');
    assert.equal(await executor.process(work), 'retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [work.turnId],
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
    assert.equal(googleReads, 1);
    assert.equal(attempts, 2);
    const history = await f.history();
    assert.equal(history.messages[0].calendarResults[0].events[0].title, 'Private provider meeting');
    assert.equal(history.messages[1].parts[0].text, 'Recovered the completed calendar read');
  } finally {
    await f.close();
  }
});
