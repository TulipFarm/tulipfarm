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

test('chat writes rows only to a table named in the chat and never while preparing a table change', async t => {
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
  const lastResult = () => String(toolResults(requests.findLast(body => !isCompletionRequest(body))).at(-1));

  await t.test('rows meant for a table that is not ready are not written to a similar table', async () => {
    replies = [
      anthropicTools([batch(['Apple', 'Banana'])]),
      anthropicText('The table stock-rv3-mig is not ready yet.'),
    ];
    const work = await send(await chat(), 'Add Apple and Banana to stock-rv3-mig (Item, Amount).');
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await count(), 0);
    const result = lastResult();
    assert.match(result, /"error":"table-not-named"/);
    assert.match(result, /No rows were changed\. Nobody in this chat named the table \\"stock-schema-mig\\"/);
  });

  await t.test('a field change request cannot add or fix rows in the same reply', async () => {
    replies = [
      anthropicTools([{ tool: 'tables.propose', input: '{}' }]),
      anthropicTools([batch(['Fixed 1', 'Fixed 2'])]),
      anthropicText('Some values block the change.'),
    ];
    const work = await send(await chat(), 'In stock-schema-mig, convert Amount from text to a number.');
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await count(), 0);
    assert.match(lastResult(), /"error":"table-change-pending"/);
  });

  await t.test('rows are written to the table the person named', async () => {
    replies = [anthropicTools([batch(['Apple', 'Banana'])]), anthropicText('Added two rows to stock-schema-mig.')];
    const work = await send(await chat(), 'Add Apple and Banana to the Stock Schema Mig table.');
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await count(), 2);
  });
});
