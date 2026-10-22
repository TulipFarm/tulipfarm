import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { lockAuthorization } from '@tulipfarm/access';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import { authorizeDm } from '../../../packages/slack/test/direct-messages.integration.mjs';
import { createSlackDirectMessages } from '@tulipfarm/slack';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { anthropicChat } from './native-chat-fixture.mjs';
import { useModelFamilies } from './model-families-fixture.mjs';

for (const decisionKind of ['tool', 'answer'])
  test(`revoked current-turn read fences dependent ${decisionKind} after model dispatch`, async () => {
    const f = await promptFixture(),
      nativeFetch = fetch,
      oldKey = process.env.ANTHROPIC_API_KEY;
    let restoreFamilies;
    let calls = 0,
      resource,
      revision;
    const requested = Promise.withResolvers(),
      release = Promise.withResolvers();
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      calls++;
      if (calls === 2) {
        requested.resolve();
        await release.promise;
      }
      const decision =
        calls === 1
          ? { kind: 'tool', call: { tool: 'rows.page', tableId: resource, revision, limit: 10 } }
          : decisionKind === 'tool'
            ? { kind: 'tool', call: { tool: 'rows.page', tableId: resource, revision, limit: 10 } }
            : { kind: 'answer', text: 'Revoked confidential invoice' };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(anthropicChat(decision, { usage: { input_tokens: 20, output_tokens: 10 } })));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const team = randomUUID(),
        field = textField('Name');
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Review')`, [team]);
      const created = await createTableWithRows({
        db: f.db,
        workspace: f.workspace,
        runtime: f.runtime,
        definition: tableDefinition({ owningTeamId: team, label: 'Invoices', fields: [field] }),
        records: [{ values: textValues(field, 'Keep this invoice') }],
      });
      resource = created.tableId;
      revision = created.revision;
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        f.workspace.membershipId,
        team,
      ]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read'),($1,$2,'table.row.delete')`,
        [team, resource],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [
        f.workspace.membershipId,
      ]);
      await authorizeDm(f);
      await f.event();
      await createSlackDirectMessages({ ...f.options, modelFamilyId: 'claude-sonnet' }).discover(f.workspace.id);
      const [work] = await createConversationExecutor(f.runtime).due(f.workspace.id);
      process.env.ANTHROPIC_API_KEY = 'synthetic';
      restoreFamilies = useModelFamilies();
      globalThis.fetch = (url, init) =>
        String(url).startsWith('https://api.anthropic.com/')
          ? nativeFetch(`http://127.0.0.1:${server.address().port}`, init)
          : nativeFetch(url, init);
      const running = createConversationActivities(f.runtime).processConversationReply(work);
      await requested.promise;
      await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
        await lockAuthorization(tx, 'write');
        await f.db.platform.query(
          `DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1 AND permission='table.row.read'`,
          [resource],
        );
      });
      release.resolve();
      await running;
      assert.equal(calls, 2);
      const catalog = (
        await f.db.platform.query(`SELECT physical_table FROM ${f.table('tf_table_catalog')} WHERE id=$1`, [resource])
      ).rows[0];
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table(catalog.physical_table)}`)).rows[0].n,
        1,
        'revoked source must preserve the invoice',
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_conversation_results')}`)).rows[0].n,
        0,
        'revoked source must not publish an answer',
      );
    } finally {
      release.resolve();
      restoreFamilies?.();
      globalThis.fetch = nativeFetch;
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldKey;
      await new Promise(resolve => server.close(resolve));
      await f.close();
    }
  });
