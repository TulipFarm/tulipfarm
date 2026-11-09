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

test('chat finds a table by the name the person used, never by an ID they would have to give', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    ops = randomUUID(),
    sales = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Ops'),($2,'Sales')`, [ops, sales]);
  // The person is in Ops only; the Sales team's name is still shown on the tables they can see.
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
    w.membershipId,
    ops,
  ]);
  const make = async (label, team = ops) => {
    const item = { ...textField('Item'), required: true, maxLength: 100 };
    const table = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label, fields: [item] }),
    });
    return { ...table, item };
  };
  const pantry = await make('Pantry Stock');
  const supplies = await make('Pantry Supplies');
  const garden = await make('Garden Stock');
  const twin = await make('Garden Stock', sales);
  for (let i = 0; i < 30; i++) await make(`Ledger ${i}`);

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
  const executor = createConversationExecutor(
    f.runtime,
    input =>
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
    undefined,
    undefined,
    () => assert.fail('No MCP action'),
  );
  // Sends one message whose reply makes one tool call, and returns that call's result.
  const ask = async (text, call) => {
    replies = [anthropicTools([frameworkCallSchema.parse(call)]), anthropicText('Done.')];
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const [output] = toolResults(requests.findLast(body => !isCompletionRequest(body))).map(String);
    return JSON.parse(output.slice(output.indexOf('{')));
  };
  const guessed = '00000000-0000-0000-0000-000000000000';
  const rows = async table =>
    Number(
      (
        await f.db.platform.query(`SELECT count(*) FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND live`, [
          table.tableId,
        ])
      ).rows[0].count,
    );
  const write = table => ({
    tool: 'rows.create.batch',
    tableId: table.tableId,
    expectedAppliedRevision: table.revision,
    rows: [{ values: { [table.item.id]: { kind: 'text', value: 'Apple' } } }],
  });

  await t.test('a guessed table ID is answered with the one table the person named', async () => {
    const result = await ask('Add Apple to Pantry Stock.', { tool: 'schema.inspect', tableId: guessed });
    assert.equal(result.error, 'table-not-found');
    assert.deepEqual(result.tables, [{ id: pantry.tableId, name: 'Pantry Stock', team: 'Ops' }]);
    assert.match(result.instruction, new RegExp(`Call this tool again with that tableId`));
    assert.match(result.instruction, /never ask the person for one/);
  });

  await t.test('a name no table has is answered with close names, never an ID question', async () => {
    const result = await ask('Add Apple to Pantry Pallets.', { tool: 'schema.inspect', tableId: guessed });
    assert.equal(result.error, 'table-not-found');
    assert.deepEqual(
      result.tables.slice(0, 2).map(table => table.name),
      ['Pantry Stock', 'Pantry Supplies'].sort(),
    );
    assert.match(result.instruction, /must list these close names/);
    assert.equal(await rows(supplies), 0);
  });

  await t.test('two tables with one name are told apart by team, including a team the person is not in', async () => {
    const guess = await ask('Add Apple to Garden Stock.', { tool: 'schema.inspect', tableId: guessed });
    assert.equal(guess.error, 'table-ambiguous');
    assert.deepEqual(guess.tables.map(table => table.team).sort(), ['Ops', 'Sales']);

    const held = await ask('Add Apple to Garden Stock.', write(garden));
    assert.equal(held.error, 'table-ambiguous');
    assert.equal(await rows(garden), 0);

    await ask('Add Apple to the Sales Garden Stock table.', write(twin));
    assert.equal(await rows(twin), 1);
  });

  await t.test('a write to a table the person did not name, while they named another, writes nothing', async () => {
    const result = await ask('Add Apple to Pantry Stock.', write(garden));
    assert.equal(result.error, 'table-not-found');
    assert.match(result.instruction, /Nothing was written: the person did not name "Garden Stock"/);
    assert.deepEqual(
      result.tables.map(table => table.id),
      [pantry.tableId],
    );
    assert.equal(await rows(garden), 0);
  });

  await t.test('table definitions find a table by name and label every table with its team', async () => {
    const named = await ask('Add Apple to Garden Stock.', { tool: 'tables.definitions', name: 'garden stock' });
    assert.deepEqual(named.tables.map(table => table.team).sort(), ['Ops', 'Sales']);
    assert.match(named.instruction, /2 tables are called "Garden Stock"/);

    const missing = await ask('Add Apple to Pantry Pallets.', { tool: 'tables.definitions', name: 'Pantry Pallets' });
    assert.deepEqual(missing.tables, []);
    assert.ok(missing.similar.some(table => table.name === 'Pantry Supplies' && table.team === 'Ops'));

    const all = await ask('What tables do I have?', { tool: 'tables.definitions' });
    assert.ok(all.tables.length);
    assert.ok(all.tables.every(table => typeof table.team === 'string' && table.team));
  });
});
