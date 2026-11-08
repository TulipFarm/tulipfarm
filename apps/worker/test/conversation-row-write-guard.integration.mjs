import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools, frameworkCallSchema } from '@tulipfarm/agents/tools';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicTools,
  anthropicText,
  toolResults,
} from './native-chat-fixture.mjs';

test('chat writes at most five requested rows directly to a named table and sends other row writes to review', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Ops')`, [team]);
  const item = { ...textField('Item'), required: true, maxLength: 100 };
  const amount = { ...textField('Amount'), maxLength: 100 };
  const table = await createTableWithRows({
    db: f.db,
    workspace: w,
    runtime: f.runtime,
    definition: tableDefinition({ owningTeamId: team, label: 'stock-schema-mig', fields: [item, amount] }),
  });
  const batch = names =>
    frameworkCallSchema.parse({
      tool: 'rows.create.batch',
      tableId: table.tableId,
      expectedAppliedRevision: table.revision,
      rows: names.map(name => ({ values: { [item.id]: { kind: 'text', value: name } } })),
    });
  const count = async () =>
    Number(
      (
        await f.db.platform.query(`SELECT count(*) FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND live`, [
          table.tableId,
        ])
      ).rows[0].count,
    );
  const requests = [];
  let replies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (isCompletionRequest(requests.at(-1))) return Response.json(completionReply('anthropic'));
    return Response.json(replies.shift());
  });
  const route = {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'fixture',
    apiKey: 'synthetic',
  };
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
  const executor = createConversationExecutor(f.runtime, reply, undefined, undefined, () =>
    assert.fail('No MCP action'),
  );
  const chat = async () => {
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    return chatId;
  };
  const send = async (chatId, text) => {
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
    return { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
  };

  const one = name =>
    frameworkCallSchema.parse({
      tool: 'rows.create',
      tableId: table.tableId,
      expectedAppliedRevision: table.revision,
      values: { [item.id]: { kind: 'text', value: name } },
    });
  const drafts = async chatId =>
    Number(
      (
        await f.db.platform.query(
          `SELECT count(*) FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1 AND proposal->>'kind'='row'`,
          [chatId],
        )
      ).rows[0].count,
    );
  const results = () => toolResults(requests.findLast(body => !isCompletionRequest(body))).map(String);
  const names = (prefix, size) => Array.from({ length: size }, (_, index) => `${prefix} ${index + 1}`);

  await t.test('rows meant for a table that is not ready go to review, not straight into a similar table', async () => {
    replies = [
      anthropicTools([batch(['Apple', 'Banana'])]),
      anthropicTools([one('Apple')]),
      anthropicText('The table stock-rv3-mig is not ready yet.'),
    ];
    const chatId = await chat();
    assert.equal(
      await executor.process(await send(chatId, 'Add Apple and Banana to stock-rv3-mig (Item, Amount).')),
      'completed',
    );
    assert.equal(await count(), 0);
    assert.equal(await drafts(chatId), 1);
    const [batchResult] = toolResults(requests.at(-2)).map(String);
    assert.match(batchResult, /"error":"review-required"/);
    assert.match(batchResult, /"reason":"table-not-named"/);
    assert.match(batchResult, /never named the table \\"stock-schema-mig\\"/);
    assert.match(results().at(-1), /"draftId".*"reason":"table-not-named"/);
  });

  await t.test('a field change request cannot add or fix rows without approval', async () => {
    replies = [
      anthropicTools([{ tool: 'tables.propose', input: '{}' }]),
      anthropicTools([batch(['Fixed 1', 'Fixed 2'])]),
      anthropicTools([one('Fixed 1')]),
      anthropicText('Some values block the change.'),
    ];
    const chatId = await chat();
    assert.equal(
      await executor.process(await send(chatId, 'In stock-schema-mig, convert Amount from text to a number.')),
      'completed',
    );
    assert.equal(await count(), 0);
    assert.equal(await drafts(chatId), 1);
    assert.match(String(toolResults(requests.at(-2)).at(-1)), /"reason":"table-change-pending"/);
    assert.match(results().at(-1), /"draftId".*"reason":"table-change-pending"/);
  });

  await t.test('up to five rows are written directly to the table the person named', async () => {
    replies = [anthropicTools([batch(names('Fruit', 5))]), anthropicText('Added five rows to stock-schema-mig.')];
    const chatId = await chat();
    assert.equal(
      await executor.process(await send(chatId, 'Add five fruits to the Stock Schema Mig table.')),
      'completed',
    );
    assert.equal(await count(), 5);
    assert.equal(await drafts(chatId), 0);
  });

  await t.test('more than five rows in one reply need approval, even across several writes', async () => {
    replies = [
      anthropicTools([batch(names('Veg', 6))]),
      anthropicTools([one('Veg 1')]),
      anthropicText('Approve each row on its card.'),
    ];
    const big = await chat();
    assert.equal(await executor.process(await send(big, 'Add six vegetables to stock-schema-mig.')), 'completed');
    assert.equal(await count(), 5);
    assert.equal(await drafts(big), 1);
    assert.match(String(toolResults(requests.at(-2)).at(-1)), /"reason":"too-many-rows"/);

    replies = [
      anthropicTools([batch(names('Nut', 3))]),
      anthropicTools([batch(names('Seed', 3))]),
      anthropicText('Added three rows; the rest need approval.'),
    ];
    const split = await chat();
    assert.equal(await executor.process(await send(split, 'Add nuts and seeds to stock-schema-mig.')), 'completed');
    assert.equal(await count(), 8);
    assert.match(results().at(-1), /"reason":"too-many-rows"/);
  });
});
