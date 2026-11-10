import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, textField, text } from '../../tables/test/fixture.mjs';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import { createChatTools } from '../src/tools.ts';
import { slackRowDraftCards } from '../src/slack-row-drafts.ts';

test('chat patches live rows without creating replacements or changing other fields', { timeout: 60000 }, async t => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-only';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Operations')`, [team]);
  const key = { ...textField('Key'), required: true };
  const note = { ...textField('Note'), required: true };
  const table = await createTableWithRows({
    db: f.db,
    workspace: w,
    runtime: f.runtime,
    definition: {
      ...tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [note, key] }),
      uniqueKeys: [{ id: randomUUID(), fieldIds: [key.id], nulls: 'distinct' }],
    },
    records: Array.from({ length: 7 }, (_, index) => ({
      values: { [key.id]: text(`T-${index + 1}`), [note.id]: text('Waiting') },
    })),
  });
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const records = createAgentRecordTools(f.runtime);
  const drafts = createAuthoringDrafts(f.runtime);
  const live = () =>
    Promise.all(table.records.map(row => records.getRecord(w.id, actor, table.tableId, table.revision, row.id)));
  const patch = async (count, value = 'Done') => ({
    tool: 'rows.update.batch',
    tableId: table.tableId,
    expectedAppliedRevision: table.revision,
    rows: (await live()).slice(0, count).map(row => ({
      recordId: row.id,
      expectedToken: row.token,
      values: { [note.id]: text(value) },
    })),
  });
  async function chat(call, message = 'Update the existing rows in Tickets: set Note to Done.', earlier) {
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: message }],
    });
    let output;
    const catalog = nativeChatTools(undefined, false, new Set());
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      const offered = catalog.tools.map(tool => tool.name);
      assert.ok(offered.includes('rows_list'));
      assert.ok(offered.includes('rows_update_batch'));
      for (const [name, input] of [
        ['schema_inspect', { tableId: table.tableId }],
        [
          'rows_list',
          {
            tableId: table.tableId,
            expectedAppliedRevision: table.revision,
            query: { version: 2, mode: 'rows', sort: [], limit: 100 },
          },
        ],
      ]) {
        const read = catalog.resolve({
          id: name,
          name,
          providerId: true,
          input: { ...input, activity: 'Finding tickets' },
        });
        assert.equal(read.ok, true);
        const found = await executeTool(
          read.call.tool,
          true,
          context => createChatTools(context.runtime).invokeWithSources(context, read.call),
          [],
          read.call,
        );
        if (name === 'rows_list')
          for (const row of call.rows)
            assert.ok(found.result.records.some(record => record.id === row.recordId && record.token));
      }
      for (const [index, update] of (earlier ? [earlier, call] : [call]).entries()) {
        const selected = catalog.resolve({
          id: `update-${index}`,
          name: 'rows_update_batch',
          providerId: true,
          input: { ...update, tool: undefined, activity: 'Updating tickets' },
        });
        assert.equal(selected.ok, true);
        assert.equal(selected.call.tool, 'rows.update.batch');
        output = await executeTool(
          selected.call.tool,
          false,
          context => createChatTools(context.runtime).invokeWithSources(context, selected.call),
          [],
          selected.call,
        );
      }
      return {
        text: output.result.error ? 'No rows changed. Try the change again.' : 'The change is ready.',
        sources: [],
      };
    });
    assert.equal(
      await executor.process({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    const history = await f.store.history(w.id, w.userId, chatId);
    const tools = history.messages.flatMap(message => message.tools);
    assert.deepEqual(
      tools.map(tool => tool.tool),
      ['schema.inspect', 'rows.list', ...(earlier ? ['rows.update.batch'] : []), 'rows.update.batch'],
    );
    assert.match(tools[2].presentation.label, /Updating/);
    return { chatId, turnId: sent.turnId, result: output.result, history, tools: tools.slice(2) };
  }
  await t.test('one partial patch preserves required fields and other rows', async () => {
    const before = await live();
    const { result } = await chat(await patch(1), 'Update the existing row T-1 in Tickets: set Note to Done.');
    assert.equal(result.records.length, 1);
    const after = await live();
    assert.deepEqual(after[0].values, { [key.id]: text('T-1'), [note.id]: text('Done') });
    assert.deepEqual(after.slice(1), before.slice(1));
    assert.notEqual(after[0].token, before[0].token);
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::integer AS count FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND live`,
          [table.tableId],
        )
      ).rows[0].count,
      7,
    );
  });
  await t.test('five rows write directly and preserve every key', async () => {
    const { result } = await chat(await patch(5, 'Checked'));
    assert.equal(result.records.length, 5);
    assert.equal(result.draftId, undefined);
    for (const [index, row] of (await live()).entries())
      assert.deepEqual(row.values, {
        [key.id]: text(`T-${index + 1}`),
        [note.id]: text(index < 5 ? 'Checked' : 'Waiting'),
      });
  });
  await t.test('six rows wait on one before/after card and approve atomically', async () => {
    const before = await live();
    const call = await patch(6, 'Approved');
    const { chatId, turnId, result, tools } = await chat(call);
    assert.equal(result.status, 'review-required');
    assert.equal(tools[0].rowDraftId, result.draftId);
    assert.deepEqual(await live(), before);
    const card = await drafts.read(w.id, w.userId, chatId, result.draftId);
    assert.equal(card.proposal.reason, 'too-many-rows');
    assert.deepEqual(card.proposal.input, call);
    assert.deepEqual(card.rowTable.labelFieldIds, [key.id]);
    for (const row of before.slice(0, 6)) assert.deepEqual(card.rowCurrents[row.id], row.values);
    const blocks = await f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return slackRowDraftCards(tx, w.id, actor, chatId, turnId);
    });
    const fields = blocks.find(block => block.type === 'section' && block.fields)?.fields;
    assert.equal(fields.length, 6);
    assert.equal(fields[0].text, 'T-1\nNote: Approved\nBefore Checked');
    assert.equal(fields[5].text, 'T-6\nNote: Approved\nBefore Waiting');
    assert.doesNotMatch(JSON.stringify(blocks), /Row 1|Row 6/);
    const decision = { commandId: randomUUID(), digest: result.digest, decision: 'save' };
    const receipt = await drafts.decide(w.id, w.userId, chatId, result.draftId, decision);
    assert.equal(receipt.operation, 'update');
    assert.deepEqual(
      receipt.recordIds,
      call.rows.map(row => row.recordId),
    );
    assert.deepEqual(await drafts.decide(w.id, w.userId, chatId, result.draftId, decision), receipt);
    assert.deepEqual((await drafts.read(w.id, w.userId, chatId, result.draftId)).rowCurrents, card.rowCurrents);
    const after = await live();
    for (const [index, row] of after.entries())
      assert.deepEqual(row.values, {
        [key.id]: text(`T-${index + 1}`),
        [note.id]: text(index < 6 ? 'Approved' : 'Waiting'),
      });
    assert.deepEqual(after[6], before[6]);
  });
  await t.test('a stale last token rolls back earlier patches and reports no changes', async () => {
    const call = await patch(2, 'Never written');
    call.rows[1].expectedToken = randomUUID();
    const before = await live();
    const { result, history } = await chat(call);
    assert.equal(result.error, 'record-conflict');
    assert.match(result.instruction, /No rows changed/);
    assert.deepEqual(await live(), before);
    assert.equal(history.messages.at(-1).parts[0].text, 'No rows changed. Try the change again.');
  });
  await t.test('review cards describe earlier direct updates as changed, not added', async () => {
    const before = await live();
    const earlier = await patch(7, 'Changed directly');
    earlier.rows = earlier.rows.slice(-1);
    const { chatId, turnId, result } = await chat(await patch(6, 'Needs review'), undefined, earlier);
    const card = await drafts.read(w.id, w.userId, chatId, result.draftId);
    assert.deepEqual(card.proposal.written, { count: 1, rows: [] });
    assert.deepEqual((await live()).slice(0, 6), before.slice(0, 6));
    const blocks = await f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return slackRowDraftCards(tx, w.id, actor, chatId, turnId);
    });
    const text = JSON.stringify(blocks);
    assert.match(text, /1 row was already changed in this reply/);
    assert.doesNotMatch(text, /already added/);
  });
  await t.test('a stale last reviewed row blocks the whole approval', async () => {
    const { chatId, result } = await chat(await patch(6, 'Outdated'));
    const last = (await live())[5];
    await records.updateRecord(
      w.id,
      actor,
      table.tableId,
      table.revision,
      last.id,
      { [note.id]: text('Changed elsewhere') },
      last.token,
    );
    const before = await live();
    assert.equal((await drafts.read(w.id, w.userId, chatId, result.draftId)).status, 'stale');
    await assert.rejects(
      drafts.decide(w.id, w.userId, chatId, result.draftId, {
        commandId: randomUUID(),
        digest: result.digest,
        decision: 'save',
      }),
      { code: 'draft-stale' },
    );
    assert.deepEqual(await live(), before);
  });
  await t.test('an invalid last patch rolls back the batch without asking for unchanged fields', async () => {
    const call = await patch(2, 'Never written');
    call.rows[1].values[note.id] = { kind: 'numeric', value: '12' };
    const before = await live();
    const { result } = await chat(call);
    assert.equal(result.error, 'invalid-values');
    assert.match(result.instruction, /Do not ask for unchanged fields/);
    assert.deepEqual(await live(), before);
  });
  await t.test('batch patches require the same update permission as single patches', async () => {
    const reader = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      reader.membershipId,
      reader.userId,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      reader.membershipId,
      team,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [team, table.tableId],
    );
    const before = await live();
    await assert.rejects(records.updateRecords(w.id, reader, await patch(2)), AccessDenied);
    assert.deepEqual(await live(), before);
  });
});
