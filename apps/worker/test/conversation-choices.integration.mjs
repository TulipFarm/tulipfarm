import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { nativeChatTools } from '../../../packages/agents/src/native-tools.ts';
import { createChatTools } from '@tulipfarm/agents/tools';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { AccessDenied } from '@tulipfarm/access';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';
import { anthropicTools, anthropicText, completionReply, isCompletionRequest } from './native-chat-fixture.mjs';
import { selectReply } from '../../../packages/agents/test/native-fixture.mjs';

test(
  'native choices persist, fence stale work, and resume the same model after answer, typed answer, skip or expiry',
  { timeout: 55000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const choice = {
      tool: 'present.choice',
      prompt: 'Who should send the Slack message?',
      choices: [
        { id: 'app', label: 'TulipFarm app (Recommended)' },
        { id: 'personal', label: 'My personal Slack account' },
      ],
    };
    assert.ok(nativeChatTools(undefined, false, new Set()).tools.some(tool => tool.name === 'present_choice'));
    const route = {
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/',
      model: 'fixture',
      apiKey: 'synthetic',
    };
    let responses = [],
      calls = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls.push(JSON.parse(options.body));
      assert.ok(responses.length, 'no model call while waiting');
      return Response.json(responses.shift());
    });
    const reply = input => {
      assert.equal(input.model, 'claude-sonnet');
      return respondToConversation(
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
    };
    for (const mode of ['choice', 'text', 'cancel', 'expire']) {
      await t.test(mode, async () => {
        const chatId = randomUUID();
        await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
        const sent = await f.store.send(w.id, w.userId, chatId, {
          messageId: randomUUID(),
          commandId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text: 'Set up the Slack workflow.' }],
        });
        const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
        responses = [anthropicTools([{ tool: 'tables.definitions' }]), anthropicTools([choice])];
        calls = [];
        const executor = createConversationExecutor(f.runtime, reply);
        assert.equal(await executor.process(work), 'idle');
        assert.equal(calls.length, 2);
        const history = await f.store.history(w.id, w.userId, chatId);
        const requestId = history.messages
          .flatMap(message => message.parts)
          .find(part => part.kind === 'request').requestId;
        assert.equal(history.messages[0].turn.status, 'waiting');
        assert.equal(await executor.process(work), 'idle');
        const restarted = f.createRuntime();
        try {
          const requests = createConversationRequests(restarted);
          const view = await requests.read(w.id, w.userId, chatId, requestId);
          assert.deepEqual(view.answerSchema, {
            kind: 'choices',
            choices: choice.choices,
            multiple: false,
            allowText: true,
          });
          const input = { commandId: randomUUID(), expectedRevision: 1 };
          if (mode === 'cancel') await requests.cancel(w.id, w.userId, chatId, requestId, input);
          else if (mode === 'expire') {
            await f.db.platform.query(
              `UPDATE ${f.table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
              [requestId],
            );
            await requests.expire(w.id);
          } else {
            const answer =
              mode === 'text'
                ? { kind: 'text', text: 'Use a different channel first.' }
                : { kind: 'choices', choiceIds: ['app'] };
            const responseId = randomUUID();
            await assert.rejects(
              requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
                ...input,
                expectedRevision: 2,
                answer,
              }),
            );
            await assert.rejects(
              requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
                ...input,
                answer: { kind: 'choices', choiceIds: ['invented'] },
              }),
            );
            const outcome = await requests.answer(w.id, w.userId, chatId, requestId, responseId, { ...input, answer });
            assert.deepEqual(
              await requests.answer(w.id, w.userId, chatId, requestId, responseId, { ...input, answer }),
              outcome,
            );
          }
          const resumed = createConversationExecutor(restarted, reply);
          assert.equal(await resumed.process(work), 'idle');
          responses =
            mode === 'choice'
              ? [
                  anthropicText('I will check existing workflows before setting up the workflow.'),
                  selectReply('anthropic', { status: 'continue', reason: 'The reply only promises work.' }),
                  anthropicTools([{ tool: 'tools.search', query: 'workflows list' }]),
                  anthropicTools([{ tool: 'workflows.list' }]),
                  anthropicText(
                    'I checked existing workflows. Which Slack channel should this workflow use? No Slack action was approved or sent.',
                  ),
                  selectReply('anthropic', {
                    status: 'waiting',
                    reason: 'The workflow needs a Slack destination not supplied by the user.',
                  }),
                ]
              : [
                  anthropicText('I have your response. No Slack action was approved or sent.'),
                  selectReply('anthropic', {
                    status: 'blocked',
                    reason: 'No action was approved; the reply states the incomplete outcome.',
                  }),
                ];
          assert.equal(await resumed.process({ ...work, generation: 1 }), 'completed');
          const replay = JSON.stringify(calls.at(-1));
          assert.match(replay, /not action approval/);
          assert.match(
            replay,
            mode === 'choice'
              ? /choiceIds/
              : mode === 'text'
                ? /different channel/
                : mode === 'cancel'
                  ? /cancelled/
                  : /expired/,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_requests')} WHERE turn_id=$1`,
                [sent.turnId],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='tables.definitions'`,
                [sent.turnId],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await f.db.platform.query(
                `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='workflows.list'`,
                [sent.turnId],
              )
            ).rows[0].count,
            mode === 'choice' ? 1 : 0,
          );
          assert.equal(
            (await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text,
            mode === 'choice'
              ? 'I checked existing workflows. Which Slack channel should this workflow use? No Slack action was approved or sent.'
              : 'I have your response. No Slack action was approved or sent.',
          );
          assert.equal(await resumed.process({ ...work, generation: 1 }), 'idle');
          assert.equal(responses.length, 0);
        } finally {
          await restarted.close();
        }
      });
    }
  },
);

test('cards made after a chat loses a table it used still open, approve and write', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Ops')`, [team]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
    w.membershipId,
    team,
  ]);
  const make = async label => {
    const name = { ...textField('Name'), required: true, maxLength: 200 };
    const table = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label, fields: [name] }),
    });
    return { ...table, name };
  };
  const contacts = await make('Contacts');
  const orders = await make('Orders');
  let responses = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (isCompletionRequest(JSON.parse(options.body))) return Response.json(completionReply('anthropic'));
    assert.ok(responses.length, 'no unplanned model call');
    return Response.json(responses.shift());
  });
  const route = {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'fixture',
    apiKey: 'synthetic',
  };
  const executor = createConversationExecutor(f.runtime, input =>
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
    ),
  );
  const requests = createConversationRequests(f.runtime);
  const drafts = createAuthoringDrafts(f.runtime);
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const send = text =>
    f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
  const lastReply = async () => (await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text;

  const asked = await send('Which field of Contacts should be the key?');
  const work = { workspaceId: w.id, conversationId: chatId, turnId: asked.turnId, generation: 0 };
  responses = [
    anthropicTools([{ tool: 'schema.inspect', tableId: contacts.tableId }]),
    anthropicTools([
      {
        tool: 'present.choice',
        prompt: 'Which field is the key?',
        choices: [
          { id: 'name', label: 'Name' },
          { id: 'email', label: 'Email' },
        ],
      },
    ]),
  ];
  assert.equal(await executor.process(work), 'idle');
  const request = (
    await f.db.platform.query(
      `SELECT r.id,s.call_id,s.output FROM ${f.table('tf_conversation_requests')} r JOIN ${f.table('tf_conversation_execution_steps')} s ON s.call_id=r.producer_id WHERE r.conversation_id=$1`,
      [chatId],
    )
  ).rows[0];
  // The question now depends on a table the person can't open, as after losing access to it.
  await f.db.platform.query(`UPDATE ${f.table('tf_conversation_execution_steps')} SET output=$2 WHERE call_id=$1`, [
    request.call_id,
    { ...request.output, sources: [{ kind: 'table-rows', tableId: randomUUID(), revision: 'a'.repeat(40) }] },
  ]);
  await assert.rejects(requests.read(w.id, w.userId, chatId, request.id), AccessDenied);
  assert.equal(
    (await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_requests')} WHERE id=$1`, [request.id]))
      .rows[0].status,
    'expired',
  );
  // The turn ends with a plain reply, without asking the model again.
  assert.equal(await executor.process({ ...work, generation: 1 }), 'idle');
  assert.match(await lastReply(), /^The review request could not be opened, so I closed it\./);

  const added = await send('Add these 9 rows to Contacts.');
  responses = [
    anthropicTools([{ tool: 'schema.inspect', tableId: orders.tableId }]),
    anthropicTools([
      {
        tool: 'rows.create.batch',
        tableId: contacts.tableId,
        expectedAppliedRevision: contacts.revision,
        rows: Array.from({ length: 9 }, (_, index) => ({
          values: { [contacts.name.id]: { kind: 'text', value: `Person ${index + 1}` } },
        })),
      },
    ]),
    anthropicText('A card holds the 9 rows for your approval.'),
  ];
  assert.equal(
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: added.turnId, generation: 0 }),
    'completed',
  );
  assert.doesNotMatch(await lastReply(), /problem in TulipFarm/);
  const draft = (
    await f.db.platform.query(`SELECT id,digest FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
      chatId,
    ])
  ).rows[0];
  // Another table the chat read changes before the card is approved; the card still opens and writes.
  const revision = randomUUID().replaceAll('-', '').padEnd(40, '0');
  await f.db.platform.query(
    `UPDATE ${f.table('tf_table_catalog')} SET target_revision=$2,applied_revision=$2 WHERE id=$1`,
    [orders.tableId, revision],
  );
  await f.db.platform.query(
    `UPDATE ${f.table('tf_table_generations')} SET revision=$2 WHERE table_id=$1 AND state='active'`,
    [orders.tableId, revision],
  );
  assert.equal((await drafts.read(w.id, w.userId, chatId, draft.id)).status, 'pending');
  const approved = await drafts.decide(w.id, w.userId, chatId, draft.id, {
    commandId: randomUUID(),
    digest: draft.digest,
    decision: 'save',
  });
  assert.equal(approved.recordIds.length, 9);
  assert.equal(responses.length, 0);
});
