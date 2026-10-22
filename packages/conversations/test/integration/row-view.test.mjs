import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createTableService } from '../../../tables/dist/service.js';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../tables/test/fixture.mjs';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test(
  'history returns authorized durable row references that requery the same persisted rows and tokens',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const team = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Support')`, [team]);
      const field = textField('Title'),
        description = textField('Description');
      const definition = tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [field, description] });
      const table = await createTableWithRows({
        db: f.db,
        workspace: f.workspace,
        runtime: f.runtime,
        definition,
        records: ['Alpha', 'Beta', 'Gamma'].map(value => ({
          values: { ...textValues(field, value), ...textValues(description, `${value} description`) },
        })),
      });
      const service = createTableService(f.runtime, {}, commonCompatibility);
      const store = createConversations(f.runtime);
      const user = f.workspace.userId,
        chatId = randomUUID();
      await store.create(f.workspace.id, user, { chatId, commandId: randomUUID() });
      const sent = await store.send(f.workspace.id, user, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Show all tickets' }],
      });
      const query = {
        version: 2,
        mode: 'rows',
        where: null,
        sort: [{ fieldId: field.id, direction: 'asc' }],
        select: [field.id],
        limit: 2,
      };
      const source = { kind: 'table-rows', tableId: definition.id, revision: table.revision };
      let first;
      const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        const call = { tool: 'rows.list', tableId: definition.id, expectedAppliedRevision: table.revision, query };
        await executeTool(
          'rows.list',
          true,
          async () => {
            first = await service.query(f.workspace.id, user, {
              tableId: definition.id,
              revision: table.revision,
              request: { query },
            });
            return { result: { version: 2, ...first }, sources: [source] };
          },
          [source],
          call,
        );
        await executeTool(
          'rows.page',
          true,
          async () => ({
            result: await service.list(f.workspace.id, user, {
              tableId: definition.id,
              revision: table.revision,
              limit: 2,
            }),
            sources: [source],
          }),
          [source],
          { tool: 'rows.page', tableId: definition.id, revision: table.revision, limit: 2 },
        );
        await executeTool(
          'rows.get',
          true,
          async () => ({
            result: await service.read(f.workspace.id, user, {
              tableId: definition.id,
              revision: table.revision,
              recordId: first.records[0].id,
            }),
            sources: [source],
          }),
          [source],
          {
            tool: 'rows.get',
            tableId: definition.id,
            expectedAppliedRevision: table.revision,
            recordId: first.records[0].id,
          },
        );
        return { text: 'The tickets are in the canvas.', sources: [source] };
      });
      assert.equal(
        await executor.process({
          workspaceId: f.workspace.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        }),
        'completed',
      );
      const history = () => createConversations(f.runtime).history(f.workspace.id, user, chatId);
      const tools = (await history()).messages[0].tools;
      assert.equal(tools.length, 3);
      const reference = tools[0].rowView;
      assert.ok(reference);
      assert.equal(reference.callId, tools[0].id);
      assert.equal(reference.tableId, definition.id);
      assert.equal(reference.revision, table.revision);
      assert.equal('output' in tools[0], false);
      const page = await service.query(f.workspace.id, user, {
        tableId: reference.tableId,
        revision: reference.revision,
        request: reference.query,
      });
      assert.deepEqual(
        page.records.map(row => [row.id, row.token]),
        first.records.map(row => [row.id, row.token]),
      );
      assert.deepEqual(reference.query.options.select, [field.id]);
      assert.equal(page.records[0].values[description.id], undefined, 'the agent selected only Title');
      assert.ok(
        page.nextCursor && !/^\d+$/.test(page.nextCursor),
        'use the real service-issued fingerprint-bound cursor',
      );
      const { select: _select, ...canvasOptions } = reference.query.options;
      const second = await service.query(f.workspace.id, user, {
        tableId: reference.tableId,
        revision: reference.revision,
        request: { ...reference.query, options: { ...canvasOptions, after: page.nextCursor } },
      });
      assert.equal(second.records.length, 1);
      assert.equal(second.records[0].values[field.id].value, 'Gamma');
      assert.equal(
        second.records[0].values[description.id].value,
        'Gamma description',
        'Records can remove select without invalidating the original cursor',
      );
      assert.equal(new Set([...page.records, ...second.records].map(row => row.id)).size, 3);
      const changed = await service.mutate(f.workspace.id, user, {
        kind: 'update',
        tableId: reference.tableId,
        revision: reference.revision,
        recordId: page.records[0].id,
        expectedToken: page.records[0].token,
        values: textValues(field, 'Alpha updated'),
      });
      const refreshed = await service.query(f.workspace.id, user, {
        tableId: reference.tableId,
        revision: reference.revision,
        request: reference.query,
      });
      assert.equal(refreshed.records[0].token, changed.token);
      assert.equal(refreshed.records[0].values[field.id].value, 'Alpha updated');
      for (const tool of tools.slice(1)) {
        const view = tool.rowView;
        assert.ok(view);
        assert.ok(view.recordIds.length > 0);
        const rows = await service.list(f.workspace.id, user, {
          tableId: view.tableId,
          revision: view.revision,
          ids: view.recordIds,
        });
        assert.deepEqual(new Set(rows.map(row => row.id)), new Set(view.recordIds));
        if (tool.tool === 'rows.get') assert.equal(rows[0].values[field.id].value, 'Alpha updated');
      }
      assert.deepEqual(
        (await history()).messages[0].tools[0].rowView,
        reference,
        'history stores a query, not old row values',
      );
      await assert.rejects(store.history(f.workspace.id, 'not-a-member', chatId), AccessDenied);

      const step = tools[0].id;
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_execution_steps')} SET output=jsonb_set(output,'{sources}',$2::jsonb) WHERE call_id=$1`,
        [step, JSON.stringify([{ kind: 'unknown' }])],
      );
      assert.equal(
        (await history()).messages[0].tools[0].rowView,
        undefined,
        'output sources cannot bypass audience checks',
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_execution_steps')} SET output=jsonb_set(output,'{sources}',$2::jsonb) WHERE call_id=$1`,
        [step, JSON.stringify([source])],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_table_catalog')} SET applied_revision=$2 WHERE id=$1`, [
        definition.id,
        'b'.repeat(40),
      ]);
      assert.ok(
        (await history()).messages[0].tools.every(tool => !tool.rowView),
        'stale or unavailable sources are not exposed for any row-read path',
      );
    } finally {
      await f.close();
    }
  },
);
