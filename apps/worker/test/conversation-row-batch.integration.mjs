import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools, discoverTools, frameworkCallSchema } from '@tulipfarm/agents/tools';
import { createAgentRecordTools } from '../../../packages/agents/src/record-tools.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';
import { respondToConversation } from '../src/conversation-responder.ts';
import { completionReply, isCompletionRequest, anthropicTools, anthropicText } from './native-chat-fixture.mjs';

test(
  'chat creates five rows atomically in one tool call with durable receipts and unchanged permission gates',
  { timeout: 55000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace,
      team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Support')`, [team]);
    const subject = { ...textField('Subject'), required: true, maxLength: 100 };
    const files = {
      id: randomUUID(),
      label: 'Files',
      kind: 'file',
      required: false,
      cardinality: 'many',
      access: 'independent',
    };
    const target = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Customers' }),
    });
    const customer = {
      id: randomUUID(),
      label: 'Customer',
      kind: 'relationship',
      required: false,
      targetTableId: target.tableId,
      cardinality: 'one',
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    };
    const definition = {
      ...tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [subject, files, customer] }),
      uniqueKeys: [{ id: randomUUID(), fieldIds: [subject.id], nulls: 'distinct' }],
    };
    const table = await createTableWithRows({ db: f.db, workspace: w, runtime: f.runtime, definition });
    const row = value => ({ values: { [subject.id]: { kind: 'text', value } } });
    const batch = rows =>
      frameworkCallSchema.parse({
        tool: 'rows.create.batch',
        tableId: table.tableId,
        expectedAppliedRevision: table.revision,
        rows,
      });
    const five = batch(Array.from({ length: 5 }, (_, i) => row(`Ticket ${i + 1}`)));
    const count = async () =>
      Number(
        (
          await f.db.platform.query(
            `SELECT count(*) FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND live`,
            [table.tableId],
          )
        ).rows[0].count,
      );
    const human = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const context = () => ({ workspaceId: w.id, actor: human, callId: randomUUID() });
    const tools = createChatTools(f.runtime);
    const requests = [];
    let response;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (isCompletionRequest(requests.at(-1))) return Response.json(completionReply('anthropic'));
      return Response.json(await response());
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
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const send = async text => {
      const sent = await f.store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text }],
      });
      return { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    };

    await t.test('inspection then one batch then summary persists five rows and one write receipt', async () => {
      const replies = [
        anthropicTools([{ tool: 'schema.inspect', tableId: table.tableId }]),
        anthropicTools([five]),
        anthropicText('Created five fake tickets.'),
      ];
      response = () => replies.shift();
      const work = await send('Add five fake tickets.');
      assert.equal(await executor.process(work), 'completed');
      assert.equal(await count(), 5);
      assert.equal(requests.length, 4);
      const history = await f.store.history(w.id, w.userId, chatId);
      assert.deepEqual(
        history.messages[0].tools.map(tool => [tool.tool, tool.status]),
        [
          ['schema.inspect', 'completed'],
          ['rows.create.batch', 'completed'],
        ],
      );
      assert.equal(history.messages[1].parts[0].text, 'Created five fake tickets.');
      const receipt = (
        await f.db.platform.query(
          `SELECT s.output FROM ${f.table('tf_conversation_execution_steps')} s JOIN ${f.table('tf_conversation_tool_calls')} c ON c.id=s.call_id WHERE c.turn_id=$1 AND c.tool='rows.create.batch'`,
          [work.turnId],
        )
      ).rows[0].output;
      assert.equal(receipt.result.records.length, 5);
      assert.equal(new Set(receipt.result.records.map(record => record.id)).size, 5);
      assert.ok(receipt.result.records.every(record => record.token));
      const change = history.messages[0].tools[1].rowChange;
      assert.equal(change.kind, 'created');
      assert.equal(change.tableId, table.tableId);
      assert.deepEqual(
        change.recordIds,
        receipt.result.records.map(record => record.id),
      );
      assert.ok(receipt.sources.some(source => source.kind === 'table-rows' && source.tableId === table.tableId));
      assert.equal(await executor.process(work), 'idle');
      assert.equal(await count(), 5);
      assert.equal(requests.length, 4);
    });

    await t.test(
      'a late duplicate, invalid value, stale revision or inaccessible reference rolls the entire batch back',
      async () => {
        for (const rows of [
          [row('Must roll back'), row('Ticket 1')],
          [row('Must roll back'), { values: {} }],
          [
            row('Must roll back'),
            { values: { ...row('Hidden file').values, [files.id]: { kind: 'file', fileIds: [randomUUID()] } } },
          ],
          [
            row('Must roll back'),
            {
              values: {
                ...row('Missing customer').values,
                [customer.id]: { kind: 'relationship', tableId: target.tableId, recordIds: [randomUUID()] },
              },
            },
          ],
        ]) {
          await assert.rejects(tools.invokeWithSources(context(), batch(rows)));
          assert.equal(await count(), 5);
        }
        await assert.rejects(
          tools.invokeWithSources(context(), { ...batch([row('Stale')]), expectedAppliedRevision: 'b'.repeat(40) }),
          /stale-generation/,
        );
        await f.db.platform.query(`UPDATE ${f.table('tf_table_catalog')} SET maintenance=true WHERE id=$1`, [
          table.tableId,
        ]);
        await assert.rejects(tools.invokeWithSources(context(), batch([row('Maintenance')])), /table-maintenance/);
        await f.db.platform.query(`UPDATE ${f.table('tf_table_catalog')} SET maintenance=false WHERE id=$1`, [
          table.tableId,
        ]);
        assert.equal(await count(), 5);
      },
    );

    await t.test('current human create permission is required and named agents cannot bypass approvals', async () => {
      const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        member.membershipId,
        member.userId,
      ]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
        member.membershipId,
        team,
      ]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
        [team, table.tableId],
      );
      await assert.rejects(
        tools.invokeWithSources({ ...context(), actor: member }, batch([row('Denied')])),
        AccessDenied,
      );
      await assert.rejects(
        createAgentRecordTools(f.runtime).createRecords(
          w.id,
          { kind: 'agent', runId: randomUUID() },
          five,
          randomUUID(),
        ),
        AccessDenied,
      );
      assert.equal(
        discoverTools({ kind: 'agent', tools: ['rows.create.batch'], task: true }).some(
          tool => tool.name === 'rows.create.batch',
        ),
        false,
      );
      assert.equal(await count(), 5);
    });

    await t.test('a lost model answer resumes from the committed batch receipt, not another write', async () => {
      const next = batch(Array.from({ length: 5 }, (_, i) => row(`Retry ${i + 1}`)));
      let step = 0;
      response = () => {
        if (++step === 1) return anthropicTools([next]);
        throw new Error('synthetic crash after committed batch');
      };
      const work = await send('Add five more fake tickets.');
      const fence = await executor.claim(work);
      await assert.rejects(executor.complete(fence), /synthetic crash/);
      assert.equal(await count(), 10);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [work.turnId],
      );
      response = () => {
        assert.match(JSON.stringify(requests.at(-1)), /Retry 1/);
        return anthropicText('Created five more fake tickets.');
      };
      assert.equal(await executor.process(work), 'completed');
      assert.equal(await count(), 10);
      const receipts = (
        await f.db.platform.query(`SELECT tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`, [
          work.turnId,
        ])
      ).rows;
      assert.deepEqual(receipts, [{ tool: 'rows.create.batch', status: 'completed' }]);
    });
  },
);
