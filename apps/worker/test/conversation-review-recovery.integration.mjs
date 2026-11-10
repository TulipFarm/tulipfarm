import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { createChatTools } from '@tulipfarm/agents/tools';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { azureChat, completionReply, isCompletionRequest } from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

test('unreadable reviews never strand a private chat or remain approval gates', { timeout: 55000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const inaccessible = [{ kind: 'table-rows', tableId: randomUUID(), revision: 'a'.repeat(40) }];
  const choice = {
    tool: 'present.choice',
    prompt: 'How should I continue?',
    choices: [
      { id: 'one', label: 'One at a time' },
      { id: 'stop', label: 'Stop' },
    ],
  };
  const requests = createConversationRequests(f.runtime);
  const chat = async () => {
    const id = randomUUID();
    await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    return id;
  };
  const send = async (id, text, model = 'claude-sonnet') => {
    const sent = await f.store.send(w.id, w.userId, id, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model,
      parts: [{ kind: 'text', text }],
    });
    return { workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 };
  };
  const invoke = (input, call) =>
    input.executeTool(
      call.tool,
      false,
      context => createChatTools(context.runtime).invokeWithSources(context, call),
      [],
      call,
    );
  const requestId = history =>
    history.messages.flatMap(message => message.parts).find(part => part.kind === 'request')?.requestId;
  const text = message =>
    message.parts
      .filter(part => part.kind === 'text')
      .map(part => part.text)
      .join('\n');
  const state = async work =>
    (await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [work.turnId]))
      .rows[0].status;

  await t.test('a question with an unreadable retained source is not published', async () => {
    const id = await chat();
    const executor = createConversationExecutor(f.runtime, async input => {
      const result = await input.executeTool(
        'present.choice',
        false,
        () => assert.fail('Runtime owns questions'),
        inaccessible,
        choice,
      );
      assert.equal(result.result.error, 'access-denied');
      return { text: 'I could not open the question. Send a new message to continue.', sources: [] };
    });
    const work = await send(id, 'Help me choose.');
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await state(work), 'completed');
    assert.equal(requestId(await f.store.history(w.id, w.userId, id)), undefined);
  });

  for (const action of ['read', 'answer'])
    await t.test(`an unreadable pending question closes on ${action} and releases a queued turn`, async () => {
      const id = await chat();
      const executor = createConversationExecutor(f.runtime, async input => {
        if (input.messages.at(-1).text === 'Continue here.') return { text: 'Ready to continue.', sources: [] };
        await invoke(input, choice);
        assert.fail('A published question must pause the reply.');
      });
      const work = await send(id, 'Help me choose.');
      assert.equal(await executor.process(work), 'idle');
      const question = requestId(await f.store.history(w.id, w.userId, id));
      assert.ok(question);
      assert.equal((await requests.read(w.id, w.userId, id, question)).status, 'pending');
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_execution_steps')} SET output=jsonb_set(output,'{sources}',$2::jsonb) WHERE call_id=(SELECT producer_id FROM ${f.table('tf_conversation_requests')} WHERE id=$1)`,
        [question, JSON.stringify(inaccessible)],
      );
      const queued = await send(id, 'Continue here.');
      const otherChat = await chat();
      await assert.rejects(requests.read(w.id, w.userId, otherChat, question));
      assert.equal(await state(work), 'waiting');
      if (action === 'read') await assert.rejects(requests.read(w.id, w.userId, id, question));
      else
        await assert.rejects(
          requests.answer(w.id, w.userId, id, question, randomUUID(), {
            commandId: randomUUID(),
            expectedRevision: 1,
            answer: { kind: 'choices', choiceIds: ['one'] },
          }),
        );
      assert.equal(await state(work), 'completed');
      assert.equal(
        (await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_requests')} WHERE id=$1`, [question]))
          .rows[0].status,
        'expired',
      );
      await assert.rejects(requests.read(w.id, w.userId, id, question));
      const history = await f.store.history(w.id, w.userId, id);
      assert.equal(
        history.messages.filter(message => text(message).includes('No pending change was approved')).length,
        1,
      );
      assert.equal(await executor.process(work), 'idle');
      assert.equal(await executor.process(queued), 'completed');
    });

  const team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Ops')`, [team]);
  const name = { ...textField('Name'), required: true };
  const email = textField('Email');
  const table = await createTableWithRows({
    db: f.db,
    workspace: w,
    runtime: f.runtime,
    definition: {
      ...tableDefinition({ owningTeamId: team, label: 'review-contacts', fields: [name, email] }),
      uniqueKeys: [{ id: randomUUID(), fieldIds: [name.id], nulls: 'distinct' }],
    },
  });
  const values = index => ({
    [name.id]: { kind: 'text', value: `Contact ${index}` },
    [email.id]: { kind: 'text', value: `contact${index}@example.test` },
  });
  const batch = {
    tool: 'rows.create.batch',
    tableId: table.tableId,
    expectedAppliedRevision: table.revision,
    rows: Array.from({ length: 9 }, (_, index) => ({ values: values(index + 1) })),
  };
  const one = {
    tool: 'rows.create',
    tableId: table.tableId,
    expectedAppliedRevision: table.revision,
    values: values(10),
  };
  const authoring = createAuthoringDrafts(f.runtime);
  const corrupt = draft =>
    f.db.platform.query(`UPDATE ${f.table('tf_chat_authoring_drafts')} SET sources=$2 WHERE id=$1`, [
      draft,
      JSON.stringify(inaccessible),
    ]);
  const decisions = async id =>
    (await f.db.platform.query(`SELECT outcome FROM ${f.table('tf_chat_authoring_decisions')} WHERE draft_id=$1`, [id]))
      .rows;

  for (const recovery of ['read', 'count', 'tool'])
    await t.test(`an unreadable draft is terminal on ${recovery} and no longer blocks a row write`, async () => {
      const id = await chat();
      let draft;
      const executor = createConversationExecutor(f.runtime, async input => {
        if (!draft) {
          draft = (await invoke(input, batch)).result.draftId;
          return { text: 'Review the nine rows.', sources: [] };
        }
        const row = { ...one, values: values(100 + ['read', 'count', 'tool'].indexOf(recovery)) };
        if (recovery === 'tool') assert.equal((await invoke(input, row)).result.error, 'review-unavailable');
        assert.equal(await input.waitingCards(), 0);
        const result = await invoke(input, row);
        assert.equal(result.result.error, undefined);
        return { text: 'Added one row.', sources: [] };
      });
      assert.equal(await executor.process(await send(id, 'Add nine rows to review-contacts.')), 'completed');
      assert.equal((await authoring.read(w.id, w.userId, id, draft)).status, 'pending');
      await corrupt(draft);
      await assert.rejects(authoring.read(w.id, w.userId, await chat(), draft));
      assert.equal((await decisions(draft)).length, 0);
      if (recovery === 'read') await assert.rejects(authoring.read(w.id, w.userId, id, draft));
      assert.equal(await executor.process(await send(id, 'Add one row to review-contacts.')), 'completed');
      assert.deepEqual(
        (await decisions(draft)).map(row => row.outcome),
        [{ kind: 'unavailable' }],
      );
      assert.match(
        (await f.store.history(w.id, w.userId, id)).messages.map(text).join('\n'),
        /review request could not be opened.*Send a new message/,
      );
      await assert.rejects(authoring.read(w.id, w.userId, id, draft));
      assert.equal((await decisions(draft)).length, 1);
    });

  await t.test('a draft that loses access before final delivery cannot publish a card claim', async () => {
    const id = await chat();
    let draft;
    const executor = createConversationExecutor(f.runtime, async input => {
      draft = (await invoke(input, batch)).result.draftId;
      await corrupt(draft);
      return { text: 'Approve the card with nine rows.', sources: [] };
    });
    assert.equal(await executor.process(await send(id, 'Add nine rows to review-contacts.')), 'completed');
    const history = await f.store.history(w.id, w.userId, id);
    assert.match(text(history.messages.at(-1)), /could not be opened.*fresh request/);
    assert.equal(
      history.messages.flatMap(message => message.tools ?? []).some(tool => tool.rowDraftId),
      false,
    );
    assert.deepEqual(
      (await decisions(draft)).map(row => row.outcome),
      [{ kind: 'unavailable' }],
    );
  });

  await t.test('a tool cannot advertise a draft that does not exist', async () => {
    const id = await chat();
    const draft = randomUUID();
    const executor = createConversationExecutor(f.runtime, async input => {
      const result = await input.executeTool(
        'rows.create.batch',
        false,
        async () => ({ result: { draftId: draft }, sources: [] }),
        [],
        batch,
      );
      assert.equal(result.result.error, 'review-unavailable');
      assert.equal(result.result.draftId, undefined);
      assert.equal(await input.waitingCards(), 0);
      return { text: 'The review failed. Send a fresh request to try again.', sources: [] };
    });
    assert.equal(await executor.process(await send(id, 'Add nine rows to review-contacts.')), 'completed');
    const history = await f.store.history(w.id, w.userId, id);
    assert.equal(
      history.messages.flatMap(message => message.tools ?? []).some(tool => tool.rowDraftId),
      false,
    );
    assert.equal((await decisions(draft)).length, 0);
  });

  await t.test('Kimi-shaped duplicate calls and four follow-ups keep the original nine-row card readable', async () => {
    t.after(useModelCatalog(['kimi']));
    const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT;
    const key = process.env.AZURE_FOUNDRY_API_KEY;
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://synthetic.openai.azure.com/';
    process.env.AZURE_FOUNDRY_API_KEY = 'synthetic';
    t.after(() => {
      if (endpoint === undefined) delete process.env.AZURE_FOUNDRY_ENDPOINT;
      else process.env.AZURE_FOUNDRY_ENDPOINT = endpoint;
      if (key === undefined) delete process.env.AZURE_FOUNDRY_API_KEY;
      else process.env.AZURE_FOUNDRY_API_KEY = key;
    });
    let replies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isCompletionRequest(body)) return Response.json(completionReply('azure', 'waiting'));
      assert.ok(replies.length, 'all provider calls use the fixture');
      return Response.json(replies.shift());
    });
    const route = {
      provider: 'azure',
      endpoint: process.env.AZURE_FOUNDRY_ENDPOINT,
      model: 'Kimi-K2.6',
      auth: { kind: 'api-key', value: 'synthetic' },
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
        {
          priorCalls: input.priorCalls,
          priorToolCalls: input.priorToolCalls,
          waitingCards: input.waitingCards,
          sources: () => [],
        },
      ),
    );
    const id = await chat();
    const turns = [
      {
        text:
          'Add these 9 rows to review-contacts (Name, Email): ' +
          Array.from({ length: 9 }, (_, index) => `Contact ${index + 1}, contact${index + 1}@example.test`).join('; '),
        responses: [
          azureChat({ kind: 'parallel', calls: [batch, batch] }),
          azureChat({ kind: 'tool', call: batch }),
          azureChat({ kind: 'tool', call: batch }),
          azureChat({ kind: 'answer', text: 'The nine rows wait on one approval card.' }),
        ],
      },
      {
        text: "Is it ready? I don't see anything yet.",
        responses: [azureChat({ kind: 'answer', text: 'The original nine-row card still needs your approval.' })],
      },
      {
        text: 'Add one more row to review-contacts: Contact 10, contact10@example.test',
        responses: [
          azureChat({ kind: 'tool', call: one }),
          azureChat({ kind: 'answer', text: 'The original card is still waiting. No row was added.' }),
        ],
      },
      {
        text: 'Add them one at a time now instead, please.',
        responses: [
          azureChat({ kind: 'tool', call: { ...one, values: values(1) } }),
          azureChat({ kind: 'tool', call: choice }),
        ],
      },
    ];
    let original;
    for (const [index, turn] of turns.entries()) {
      replies = turn.responses;
      const work = await send(id, turn.text, 'kimi');
      assert.equal(await executor.process(work), index === 3 ? 'idle' : 'completed');
      assert.equal(replies.length, 0);
      const drafts = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
          id,
        ])
      ).rows;
      assert.equal(drafts.length, 1);
      original ??= drafts[0].id;
      assert.equal(drafts[0].id, original);
      assert.equal((await authoring.read(w.id, w.userId, id, original)).status, 'pending');
      if (index === 3) {
        const question = requestId(await f.store.history(w.id, w.userId, id));
        assert.equal((await requests.read(w.id, w.userId, id, question)).status, 'pending');
        await requests.cancel(w.id, w.userId, id, question, { commandId: randomUUID(), expectedRevision: 1 });
        replies = [azureChat({ kind: 'answer', text: 'The question is closed. The row card still needs approval.' })];
        assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
      }
    }
    const view = await authoring.read(w.id, w.userId, id, original);
    const saved = await authoring.decide(w.id, w.userId, id, original, {
      commandId: randomUUID(),
      digest: view.digest,
      decision: 'save',
    });
    assert.equal(saved.recordIds.length, 9);
    const records = (
      await f.db.platform.query(
        `SELECT count(*)::int AS count FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND row_id=ANY($2::uuid[]) AND live`,
        [table.tableId, saved.recordIds],
      )
    ).rows[0].count;
    assert.equal(records, 9);
  });
});
