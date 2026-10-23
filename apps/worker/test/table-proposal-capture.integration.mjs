import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { executionCompatibility } from '@tulipfarm/tables/execution';

test(
  'production proposal options preserve online scan capture and bounded finalize for 100000 records',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime, migration;
    t.after(async () => {
      await runtime?.close();
      await migration?.end();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    assert.equal(migrations.length, 10);
    const ws = await db.create(migrations);
    t.diagnostic(`Workspace common stream: ${migrations.length}`);
    const s = `"${ws.names.schema}"`;
    assert.deepEqual(
      (await db.platform.query(`SELECT name FROM ${s}.tf_common_migrations ORDER BY name`)).rows.map(row => row.name),
      migrations.map(item => item.name),
    );
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      connectionsPerPool: 3,
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    migration = await connect(db.login(ws, 'migration'));
    const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
    const team = randomUUID(),
      chat = randomUUID(),
      message = randomUUID(),
      turn = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Capture fixture')`, [team]);
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
    const tableId = randomUUID(),
      title = randomUUID(),
      notes = randomUUID(),
      revision = 'a'.repeat(40);
    const definition = {
      formatVersion: 2,
      id: tableId,
      owningTeamId: team,
      label: 'Capture records',
      fields: [title, notes].map(id => ({ id, kind: 'text', label: 'Text', required: false, maxLength: 1000 })),
      uniqueKeys: [],
    };
    const generation = await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
      const tx = { client, schema: ws.names.schema };
      const result = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: result.id, expectedActiveGenerationId: null });
      await client.query(
        `UPDATE ${s}.tf_table_catalog SET physical_table=$2,applied_revision=$3,target_revision=$3,applied_definition=$4 WHERE id=$1`,
        [tableId, result.physical_table, revision, definition],
      );
      return result;
    });
    const count = 100000,
      first = '00000000-0000-4000-8000-000000000001';
    const column = id => `"f_${id.replaceAll('-', '')}"`;
    await db.platform.query(
      `INSERT INTO ${s}."${generation.physical_table}"(id,token,${column(title)},${column(notes)}) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),'  value  ','initial' FROM generate_series(1,$1) i`,
      [count],
    );
    for (let offset = 0; offset < count; offset += 1000) {
      await db.platform.query(
        `INSERT INTO ${s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) SELECT $1,id,token,token,jsonb_build_object($2::text,token,$3::text,token),true FROM ${s}."${generation.physical_table}" ORDER BY id LIMIT 1000 OFFSET $4`,
        [tableId, title, notes, offset],
      );
    }
    await db.platform.query(`ANALYZE ${s}.tf_table_identities`);
    const records = createTableService(
      runtime,
      { readableFiles: async () => assert.fail('Unexpected file') },
      executionCompatibility,
    );
    const write = async (field, value) => {
      const row = await records.read(ws.id, actor, { tableId, revision, recordId: first });
      return records.mutate(ws.id, actor, {
        kind: 'update',
        tableId,
        revision,
        recordId: first,
        expectedToken: row.token,
        values: { [field]: { kind: 'text', value } },
      });
    };
    const options = tableProposalOptions(runtime);
    const locks = [],
      pages = [];
    let probe = async () => {
      await write(notes, 'written during scan');
    };
    const data = {
      ...options.data,
      async lock(...args) {
        const result = await options.data.lock(...args);
        locks.push({ mode: args[2], result });
        return result;
      },
      async records(...args) {
        const rows = await options.data.records(...args);
        pages.push(rows.length);
        if (probe && rows.length) {
          const action = probe;
          probe = null;
          await action();
        }
        return rows;
      },
    };
    const proposals = createTableProposals({ ...options, data });
    const decisions = createTableProposalDecisions({
      ...options,
      data,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    const input = {
      plans: [
        {
          kind: 'schema',
          tableId,
          expectedRevision: revision,
          dependsOn: [],
          target: definition,
          transforms: {
            outputs: [{ fieldId: title, expression: { op: 'trim', input: { op: 'field', fieldId: title } } }],
          },
        },
      ],
    };
    const start = performance.now();
    const proposal = await proposals.propose(
      ws.id,
      actor,
      randomUUID(),
      { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
      input,
    );
    assert.deepEqual(
      locks.map(item => item.mode),
      ['scan', 'finalize'],
    );
    assert.equal(locks[0].result, 'capture');
    assert.ok(pages.length > 1 && pages.every(size => size <= 1000));
    const counts = (
      await db.platform.query(
        `SELECT (SELECT count(*)::int FROM ${s}.tf_table_proposal_effects WHERE proposal_id=$1) effects,(SELECT count(*)::int FROM ${s}.tf_table_proposal_freshness WHERE proposal_id=$1) freshness,(SELECT count(*)::int FROM ${s}.tf_table_proposal_capture WHERE proposal_id=$1) captures`,
        [proposal.id],
      )
    ).rows[0];
    assert.deepEqual(counts, { effects: count, freshness: count, captures: 1 });
    const previewMs = Math.round(performance.now() - start),
      scannedPages = pages.length;
    await write(notes, 'written before approval');
    const approval = await decisions.decide(ws.id, ws.userId, chat, proposal.id, {
      commandId: randomUUID(),
      digest: proposal.digest,
      decision: 'approve',
    });
    assert.equal(approval.status, 'approved');
    assert.equal(pages.length, scannedPages, 'Approval uses retained capture without rescanning records');
    assert.equal(locks.at(-1).mode, 'finalize');
    await write(title, '  changed  ');
    await assert.rejects(
      decisions.control(ws.id, ws.userId, chat, proposal.id, {
        commandId: randomUUID(),
        digest: proposal.digest,
        operation: 'resume',
      }),
      /proposal-stale/,
    );
    assert.equal(
      (
        await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_proposal_controls WHERE proposal_id=$1`, [
          proposal.id,
        ])
      ).rows[0].n,
      0,
    );
    t.diagnostic(
      JSON.stringify({
        rows: count,
        previewMs,
        scannedPages,
        captures: counts.captures,
        approvalRescans: pages.length - scannedPages,
      }),
    );
  },
);
