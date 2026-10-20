import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { escapeIdentifier } from 'pg';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { connect, denied, markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { createChatTools } from '@tulipfarm/agents/tools';
import { mergeSources } from '@tulipfarm/conversations/results';
import { tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { requireTableSources } from '@tulipfarm/agents/table-sources';
import { createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication, executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';

test(
  'compiled cleanup startup and Temporal reconciliation preserve recovery and audit on the current stream',
  { timeout: 120000 },
  async t => {
    const f = await conversationFixture(),
      ws = f.workspace,
      s = `"${ws.names.schema}"`;
    const role = `cleanup_${randomUUID().replaceAll('-', '')}`,
      password = randomBytes(32).toString('hex');
    let child,
      connection,
      output = '';
    const stop = async signal => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(signal);
      await exited;
    };
    t.after(async () => {
      await stop('SIGTERM');
      await connection?.close();
      await f.close();
      const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
      try {
        await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      } finally {
        await admin.end();
      }
    });
    const team = randomUUID(),
      chat = randomUUID(),
      table = randomUUID(),
      field = randomUUID();
    await f.db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Cleanup')`, [team]);
    await f.db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
    await f.store.create(ws.id, ws.userId, { chatId: chat, commandId: randomUUID() });
    const definition = {
      formatVersion: 2,
      id: table,
      owningTeamId: team,
      label: 'Private cleanup records',
      fields: [{ id: field, label: 'Value', kind: 'text', required: false, maxLength: 1000 }],
      uniqueKeys: [],
    };
    const decisions = createTableProposalDecisions({
      ...tableProposalOptions(f.runtime),
      resolveConfirmationCredential: async () => f.db.login(ws, 'confirmation'),
    });
    const advance = createTableExecution({
      requireSources: requireTableSources,
      resolveMigrationCredential: async () => f.db.login(ws, 'migration'),
    });
    let revision = 0;
    const publish = createTablePublication({
      runtime: f.runtime,
      requireSources: requireTableSources,
      prepareRevision: async input => ({
        commit: (++revision).toString(16).padStart(40, '0'),
        parentCommit: input.expectedParentCommit,
        bundle: { key: input.commandId, sha256: 'b'.repeat(64) },
        projection: {},
      }),
    });
    const propose = async expectedRevision => {
      const sent = await f.store.send(ws.id, ws.userId, chat, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Review this table change' }],
      });
      let proposal, toolResponse, toolError;
      const activities = createConversationActivities(f.runtime, async ({ executeTool }) => {
        const response = await executeTool('tables.propose', false, async context => {
          const origin = { ...context.origin, sources: mergeSources(context.origin.sources) };
          assert.deepEqual(origin.sources, [{ kind: 'private-conversation', conversationId: chat }]);
          try {
            return await createChatTools(context.runtime).invokeWithSources(
              { ...context, origin },
              {
                tool: 'tables.propose',
                input: JSON.stringify({
                  plans: [
                    {
                      kind: 'schema',
                      tableId: table,
                      expectedRevision,
                      dependsOn: [],
                      target: definition,
                      transforms: { outputs: [] },
                    },
                  ],
                }),
              },
            );
          } catch (error) {
            toolError = error;
            throw error;
          }
        });
        toolResponse = response;
        proposal = response.result;
        return { text: 'Review the proposed change.', sources: response.sources };
      });
      const state = await activities.processConversationReply({
        workspaceId: ws.id,
        conversationId: chat,
        turnId: sent.turnId,
        generation: 0,
      });
      if (toolError) throw toolError;
      assert.equal(state, 'completed', JSON.stringify(toolResponse));
      assert.equal(proposal.status, 'pending');
      const manifest = (
        await f.db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [proposal.id])
      ).rows[0].manifest;
      assert.deepEqual(manifest.sources, [{ kind: 'private-conversation', conversationId: chat }]);
      assert.equal(
        (
          await f.db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_proposal_capture WHERE proposal_id=$1`, [
            proposal.id,
          ])
        ).rows[0].n,
        1,
      );
      await decisions.decide(ws.id, ws.userId, chat, proposal.id, {
        commandId: randomUUID(),
        digest: proposal.digest,
        decision: 'approve',
      });
      return proposal;
    };
    const finish = async proposal => {
      for (let i = 0; i < 20; i++) {
        const state = await advance(ws.id, proposal.id);
        if (state === 'completed') return;
        assert.notEqual(state, 'blocked');
        if (state === 'publish') await publish(ws.id, proposal.id);
      }
      assert.fail('Execution did not complete');
    };
    await finish(await propose(null));
    const service = createTableService(
      f.runtime,
      { readableFiles: async () => assert.fail('No file access expected') },
      executionCompatibility,
    );
    const record = await service.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId: table,
      revision: '1'.padStart(40, '0'),
      recordId: randomUUID(),
      values: { [field]: { kind: 'text', value: 'Private retained value' } },
    });
    await finish(await propose('1'.padStart(40, '0')));
    const pending = await propose('2'.padStart(40, '0'));
    await publish(ws.id, pending.id);
    await advance(ws.id, pending.id);
    const generations = (await f.db.platform.query(`SELECT * FROM ${s}.tf_table_generations ORDER BY revision`)).rows;
    const [retired, active, building] = generations;
    await f.db.platform.query(
      `UPDATE ${s}.tf_table_generations SET created_at=now()-interval '31 days',retired_at=CASE WHEN state='retired' THEN now()-interval '31 days' ELSE retired_at END`,
    );
    const original = (
      await f.db.platform.query(`SELECT * FROM ${s}.tf_table_row_history_data WHERE row_id=$1 LIMIT 1`, [record.id])
    ).rows[0];
    await f.db.platform.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
      original.id,
      randomUUID(),
    ]);
    await f.db.platform.query(
      `INSERT INTO ${s}.tf_table_row_history_data(id,table_id,row_id,generation_id,token,actor,operation,field_ids,created_at,recoverable_until,values,before_values) SELECT gen_random_uuid(),table_id,row_id,$2,token,actor,operation,field_ids,now()-interval '31 days',now()-interval '1 day',values,values FROM ${s}.tf_table_row_history_data CROSS JOIN generate_series(1,103) WHERE id=$1`,
      [original.id, active.id],
    );
    const audit = async () =>
      (
        await f.db.platform.query(
          `SELECT id,table_id,row_id,generation_id,token,actor,operation,field_ids,outcome,created_at,recoverable_until FROM ${s}.tf_table_row_history_data ORDER BY id`,
        )
      ).rows;
    const beforeAudit = await audit();
    const receipts = (
      await f.db.platform.query(`SELECT * FROM ${s}.tf_table_proposal_receipts ORDER BY proposal_id,attempt`)
    ).rows;
    const expired = async () =>
      (
        await f.db.platform.query(
          `SELECT count(*)::int n FROM ${s}.tf_table_row_history_data WHERE recoverable_until<now() AND values IS NOT NULL`,
        )
      ).rows[0].n;
    const exists = async g =>
      (await f.db.platform.query('SELECT to_regclass($1) IS NOT NULL present', [`${s}."${g.physical_table}"`])).rows[0]
        .present;
    const keys = Object.fromEntries(
      ['runtime', 'migration', 'confirmation'].map(capability => [capability, { keyId: 'test', key: randomBytes(32) }]),
    );
    await markWorkspaceReady(f.db.platform, ws.id);
    await f.db.platform.query('UPDATE app.workspace_storage SET migration_credential = $2 WHERE workspace_id = $1', [
      ws.id,
      encryptCredential(
        f.db.login(ws, 'migration'),
        { workspaceId: ws.id, generation: 1, capability: 'migration' },
        keys.migration,
      ),
    ]);
    await provisionTableRegistry(f.db.platform, { capability: 'migration', role, password });
    const registryUrl = new URL(f.db.connectionString);
    registryUrl.username = role;
    registryUrl.password = password;
    const registry = await connect(registryUrl.href),
      migration = await connect(f.db.login(ws, 'migration'));
    try {
      await denied(registry, `SELECT * FROM ${s}.tf_table_row_history_data`);
      await denied(registry, 'SELECT runtime_credential FROM app.workspace_storage');
      await denied(migration, `SELECT title FROM ${s}.tf_conversations`);
      await denied(migration, 'SELECT * FROM app.accounts');
    } finally {
      await registry.end();
      await migration.end();
    }
    const endpoint = new URL(f.db.connectionString);
    endpoint.username = '';
    endpoint.password = '';
    const queue = `cleanup-${randomUUID()}`,
      address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_PROVISIONING_DATABASE_URL: f.db.connectionString,
      WORKSPACE_DATABASE_ENDPOINT: endpoint.href,
      WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: registryUrl.href,
      TEMPORAL_ADDRESS: address,
      TEMPORAL_STORAGE_TASK_QUEUE: queue,
      R2_ACCESS_KEY_ID: 'unused',
      R2_SECRET_ACCESS_KEY: 'unused',
      R2_ENDPOINT: 'http://127.0.0.1:1',
    };
    for (const [capability, key] of Object.entries(keys)) {
      env[`WORKSPACE_${capability.toUpperCase()}_KEY_ID`] = key.keyId;
      env[`WORKSPACE_${capability.toUpperCase()}_KEY`] = key.key.toString('hex');
    }
    const start = () => {
      child = spawn(process.execPath, ['dist/storage-worker.js'], {
        cwd: new URL('..', import.meta.url),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', data => {
        output += data;
      });
      child.stderr.on('data', data => {
        output += data;
      });
    };
    connection = await Connection.connect({ address });
    const temporal = new Client({ connection });
    start();
    for (let i = 0; (await expired()) === 103; i++) {
      assert.ok(i < 300 && child.exitCode === null, output);
      await setTimeout(50);
    }
    assert.equal(await expired(), 3, 'startup runs one bounded 100-row batch');
    const reconcile = async () => {
      const handle = await temporal.workflow.start('reconcileTableCleanup', {
        workflowId: randomUUID(),
        taskQueue: queue,
        args: [ws.id],
        workflowExecutionTimeout: '30 seconds',
      });
      assert.equal(await handle.result(), 'completed');
      const history = JSON.stringify(await handle.fetchHistory(), (_key, value) =>
        value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : value?.type === 'Buffer' && Array.isArray(value.data)
            ? Buffer.from(value.data).toString('utf8')
            : value,
      );
      assert.equal(history.includes('Private retained value'), false);
    };
    await reconcile();
    assert.equal(await expired(), 0);
    assert.deepEqual(await audit(), beforeAudit);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT * FROM ${s}.tf_table_proposal_receipts ORDER BY proposal_id,attempt`)).rows,
      receipts,
    );
    for (const g of generations) assert.equal(await exists(g), true, g.state);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT values FROM ${s}.tf_table_row_history_data WHERE id=$1`, [original.id]))
        .rows[0].values,
      original.values,
    );
    await decisions.control(ws.id, ws.userId, chat, pending.id, {
      commandId: randomUUID(),
      digest: pending.digest,
      operation: 'cancel',
    });
    assert.equal(await advance(ws.id, pending.id), 'blocked');
    await reconcile();
    assert.equal(await exists(building), true, 'unexpired blocked execution remains resumable');
    await f.db.platform.query(`DELETE FROM ${s}.tf_table_history_holds WHERE history_id=$1`, [original.id]);
    await reconcile();
    assert.equal(await exists(retired), true, 'unexpired record recovery preserves the retired generation');
    await f.db.platform.query(
      `UPDATE ${s}.tf_table_generations SET activated_at=now()-interval '31 days' WHERE id=$1`,
      [retired.id],
    );
    await f.db.platform.query(
      `UPDATE ${s}.tf_table_row_history_data SET recoverable_until=now()-interval '1 day' WHERE generation_id=$1`,
      [retired.id],
    );
    await reconcile();
    assert.equal(await exists(retired), false);
    assert.equal(await exists(active), true);
    await stop('SIGKILL');
    await f.db.platform.query(
      `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`,
      [pending.id],
    );
    start();
    await reconcile();
    assert.equal(await exists(building), false);
    assert.equal(await exists(active), true);
    assert.equal(
      (await service.read(ws.id, ws.userId, { tableId: table, revision: active.revision, recordId: record.id })).values[
        field
      ].value,
      'Private retained value',
    );
    assert.deepEqual(await audit(), beforeAudit);
    await stop('SIGTERM');
    assert.equal(child.exitCode, 0, output);
    assert.equal(output.includes('Table cleanup sweep failed'), false, output);
    for (const secret of [
      password,
      ...Object.values(keys).map(key => key.key.toString('hex')),
      'Private retained value',
    ])
      assert.equal(output.includes(secret), false);
  },
);
