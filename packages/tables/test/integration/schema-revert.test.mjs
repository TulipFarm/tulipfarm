import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createTableProposals, createTableProposalDecisions } from '../../../tables/dist/proposals.js';
import {
  createTableExecution,
  createTablePublication,
  executionCompatibility,
} from '../../../tables/dist/execution.js';
import { createTableService } from '../../../tables/dist/service.js';
import { tableProposalOptions } from '../../../agents/src/table-proposals.ts';
import { createTableSchemaHistory } from '../../../../apps/api/src/table-schema-history.ts';
import { createTableSchemaRevert, SchemaRevertError } from '../../../../apps/api/src/table-schema-revert.ts';
import { createConversations } from '../../../conversations/src/index.ts';

test(
  'a reviewed revert undoes the latest schema change and restores values nobody wrote since',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const ws = await db.create(await workspaceTableMigrations()),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId },
      chat = randomUUID(),
      turn = randomUUID(),
      message = randomUUID(),
      team = randomUUID(),
      reader = randomUUID(),
      readerMembership = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Planning')`, [team]);
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      readerMembership,
      reader,
    ]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
      [chat, ws.userId, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
      [message, chat, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
      [turn, chat, message],
    );
    await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
    const options = tableProposalOptions(runtime);
    const proposals = createTableProposals(options);
    const decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    const advance = createTableExecution({
      ...options,
      resolveMigrationCredential: async () => db.login(ws, 'migration'),
    });
    let revisions = 0;
    const publish = createTablePublication({
      ...options,
      prepareRevision: async input => ({
        commit: (++revisions).toString(16).padStart(40, '0'),
        parentCommit: input.expectedParentCommit,
        bundle: { key: `test/${input.commandId}`, sha256: 'b'.repeat(64) },
        projection: { definition: input.definition },
      }),
    });
    const service = createTableService(runtime, options, executionCompatibility);
    const history = createTableSchemaHistory(options);
    const revert = createTableSchemaRevert(options);
    const revision = async () =>
      (
        await db.platform.query(`SELECT revision FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`, [
          tasks.id,
        ])
      ).rows[0]?.revision ?? null;
    const finish = async (chatId, p) => {
      await decisions.decide(ws.id, ws.userId, chatId, p.id, {
        digest: p.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
      for (let i = 0; i < 100; i++) {
        const state = await advance(ws.id, p.id);
        if (state === 'completed' || state === 'blocked') return state;
        if (state === 'publish') await publish(ws.id, p.id);
      }
      assert.fail('did not converge');
    };
    const change = async (target, transforms = { outputs: [] }) =>
      finish(
        chat,
        await proposals.propose(
          ws.id,
          actor,
          randomUUID(),
          { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
          {
            plans: [
              {
                kind: 'schema',
                tableId: target.id,
                dependsOn: [],
                expectedRevision: await revision(),
                target,
                transforms,
              },
            ],
          },
        ),
      );
    const entries = async (userId = ws.userId) =>
      (await history.history(ws.id, userId, tasks.id, { limit: 20 })).entries;
    const latest = async () => (await entries()).find(entry => entry.revert === 'available');
    /** Proposes the revert from Schema history and returns the generated chat and its pending proposal. */
    const proposeRevert = async executionId => {
      const chatId = randomUUID();
      assert.deepEqual(await revert.propose(ws.id, ws.userId, tasks.id, executionId, chatId), { chatId });
      const step = (
        await db.platform.query(
          `SELECT x.output FROM ${s}.tf_conversation_execution_steps x JOIN ${s}.tf_conversation_turns t ON t.id=x.turn_id
        WHERE t.conversation_id=$1 AND t.status='completed'`,
          [chatId],
        )
      ).rows[0];
      return { chatId, proposal: step.output.result };
    };

    const title = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 },
      due = { id: randomUUID(), label: 'Due', kind: 'text', required: false, maxLength: 1000 };
    const tasks = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tasks',
      fields: [title, due],
      uniqueKeys: [],
    };
    assert.equal(await change(tasks), 'completed');
    await db.platform.query(
      `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [readerMembership, tasks.id],
    );
    assert.equal((await entries())[0].revert, null, 'Creating a table is not a change that can be reverted');
    const create = async values =>
      service.mutate(ws.id, ws.userId, {
        kind: 'create',
        tableId: tasks.id,
        revision: await revision(),
        recordId: randomUUID(),
        values,
      });
    const text = value => ({ kind: 'text', value });
    const kept = await create({ [title.id]: text('Plan'), [due.id]: text('2024-01-02T09:30:00+05:30') });
    const edited = await create({ [title.id]: text('Ship'), [due.id]: text('2024-02-01T00:00:00Z') });
    const empty = await create({ [title.id]: text('Rest') });

    await t.test('renaming a field and reverting it', async () => {
      assert.equal(await change({ ...tasks, fields: [{ ...title, label: 'Name' }, due] }), 'completed');
      const rename = await latest();
      assert.equal(rename.definition.fields[0].label, 'Name');
      const { chatId, proposal } = await proposeRevert(rename.id);
      assert.equal(proposal.status, 'pending');
      assert.deepEqual(
        await revert.propose(ws.id, ws.userId, tasks.id, rename.id, chatId),
        { chatId },
        'Retries reuse the chat',
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${s}.tf_conversation_messages WHERE conversation_id=$1`,
            [chatId],
          )
        ).rows[0].n,
        2,
      );
      const view = await proposals.read(ws.id, ws.userId, chatId, proposal.id);
      assert.equal(view.freshness, 'current');
      assert.equal(view.manifest.plans[0].after.fields[0].label, 'Title');
      const reply = (
        await db.platform.query(
          `SELECT p.text FROM ${s}.tf_conversation_parts p JOIN ${s}.tf_conversation_messages m ON m.id=p.message_id
        WHERE m.conversation_id=$1 ORDER BY m.sequence`,
          [chatId],
        )
      ).rows.map(row => row.text);
      assert.equal(reply.length, 2);
      const { messages } = await createConversations(runtime).history(ws.id, ws.userId, chatId);
      assert.deepEqual(
        messages[0].tools.map(tool => [tool.id, tool.tool, tool.status]),
        [[proposal.id, 'tables.propose', 'completed']],
        'The chat shows the proposal for review',
      );
      assert.equal(messages[0].turn.status, 'completed');
      assert.match(reply[1], /reverts the latest schema change to Tasks/);
      assert.equal(await finish(chatId, proposal), 'completed');
      const after = await entries();
      const reverted = after.find(entry => entry.reverts === rename.id);
      assert.ok(reverted, 'The revert links to the change it reverted');
      assert.equal(reverted.definition.fields[0].label, 'Title');
      assert.equal(reverted.revert, 'available');
      assert.equal(after.find(entry => entry.id === rename.id).revert, 'later-changes');
    });

    await t.test('reverting text to timestamp restores retained text for rows nobody wrote since', async () => {
      const timestamp = { id: due.id, label: 'Due', kind: 'timestamp', required: false, timezone: 'UTC' };
      const convert = {
        fieldId: due.id,
        expression: {
          op: 'convert',
          input: { op: 'field', fieldId: due.id },
          to: 'timestamp',
          timezone: 'UTC',
          onError: 'error',
        },
      };
      assert.equal(await change({ ...tasks, fields: [title, timestamp] }, { outputs: [convert] }), 'completed');
      const read = async recordId =>
        service.read(ws.id, ws.userId, { tableId: tasks.id, revision: await revision(), recordId });
      const current = await read(edited.id);
      await service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: tasks.id,
        revision: await revision(),
        recordId: edited.id,
        expectedToken: current.token,
        values: { [due.id]: { kind: 'timestamp', value: '2025-05-05T05:05:05.000Z' } },
      });
      const { chatId, proposal } = await proposeRevert((await latest()).id);
      const reply = (
        await db.platform.query(
          `SELECT p.text FROM ${s}.tf_conversation_parts p JOIN ${s}.tf_conversation_messages m ON m.id=p.message_id
        WHERE m.conversation_id=$1 AND m.sequence=2`,
          [chatId],
        )
      ).rows[0].text;
      assert.match(reply, /Due: 1 row gets back its value from before the change; 2 rows keep their current values\./);
      assert.equal(await finish(chatId, proposal), 'completed');
      const values = new Map();
      for (const row of [kept, edited, empty]) values.set(row.id, (await read(row.id)).values[due.id] ?? null);
      assert.deepEqual(
        values.get(kept.id),
        text('2024-01-02T09:30:00+05:30'),
        'Unchanged rows get their original text',
      );
      assert.deepEqual(values.get(edited.id), text('2025-05-05T05:05:05.000Z'), 'Edited rows keep their current value');
      assert.equal(values.get(empty.id) ?? null, null);
    });

    await t.test('reverting text to numeric restores texts the conversion cleared or reformatted', async () => {
      const amount = { id: randomUUID(), label: 'Amount', kind: 'text', required: false, maxLength: 1000 };
      const texts = { [title.id]: text('Pay') };
      assert.equal(await change({ ...tasks, fields: [title, due, amount] }), 'completed');
      const rows = [];
      for (const value of ['1e3', 'abc', '100.50', '5'])
        rows.push([value, await create({ ...texts, [amount.id]: text(value) })]);
      const numeric = { id: amount.id, label: 'Amount', kind: 'numeric', required: false, precision: 12, scale: 3 };
      const convert = {
        fieldId: amount.id,
        expression: {
          op: 'convert',
          input: { op: 'field', fieldId: amount.id },
          to: 'numeric',
          timezone: 'UTC',
          onError: 'null',
        },
      };
      assert.equal(await change({ ...tasks, fields: [title, due, numeric] }, { outputs: [convert] }), 'completed');
      const conversion = await latest();
      const read = async recordId =>
        (await service.read(ws.id, ws.userId, { tableId: tasks.id, revision: await revision(), recordId })).values[
          amount.id
        ] ?? null;
      assert.deepEqual(
        await Promise.all(rows.map(([, row]) => read(row.id))),
        [null, null, { kind: 'numeric', value: '100.500' }, { kind: 'numeric', value: '5.000' }],
        'The conversion cleared unparseable text and padded decimals to the field scale',
      );
      const { chatId, proposal } = await proposeRevert(conversion.id);
      const reply = (
        await db.platform.query(
          `SELECT p.text FROM ${s}.tf_conversation_parts p JOIN ${s}.tf_conversation_messages m ON m.id=p.message_id
        WHERE m.conversation_id=$1 AND m.sequence=2`,
          [chatId],
        )
      ).rows[0].text;
      assert.match(
        reply,
        /Amount: 4 rows get back their values from before the change; 3 rows keep their current values\./,
      );
      assert.equal(await finish(chatId, proposal), 'completed');
      assert.deepEqual(
        await Promise.all(rows.map(([, row]) => read(row.id))),
        rows.map(([value]) => text(value)),
        'Every unchanged row gets its own original text back',
      );
      const reverted = (await entries()).find(entry => entry.reverts === conversion.id);
      assert.deepEqual(reverted.revertedChanges, ['Amount: text to number', 'Recomputed values of Amount']);
    });

    await t.test('revert is offered only on the latest change, to schema managers, on active tables', async () => {
      const all = await entries();
      assert.deepEqual(
        all.filter(entry => entry.revert === 'available').length,
        1,
        'Only the latest completed change can be reverted',
      );
      const older = all.find(entry => entry.revert === 'later-changes');
      await assert.rejects(revert.propose(ws.id, ws.userId, tasks.id, older.id, randomUUID()), SchemaRevertError);
      assert.ok(
        (await entries(reader)).every(entry => entry.revert === null),
        'Readers cannot revert',
      );
      await assert.rejects(
        revert.propose(ws.id, reader, tasks.id, (await latest()).id, randomUUID()),
        SchemaRevertError,
      );
      const current = (await latest()).id;
      await db.platform.query(`UPDATE ${s}.tf_table_catalog SET archived_at=now() WHERE id=$1`, [tasks.id]);
      assert.ok(
        (await entries()).every(entry => entry.revert === null),
        'Archived tables cannot be reverted',
      );
      await assert.rejects(revert.propose(ws.id, ws.userId, tasks.id, current, randomUUID()), SchemaRevertError);
    });
  },
);
