import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { fixture, connect, denied } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';
import { tableProposalDigest } from '@tulipfarm/tables/proposals';
import {
  createRecordRequests,
  recordMutationResultSchema,
  recordRequestStatusSchema,
} from '../src/table-record-requests.ts';

test('record receipts redact snapshots after 30 days while retaining immutable idempotency and authorized metadata', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const ws = await db.create(await workspaceTableMigrations());
  const s = `"${ws.names.schema}"`,
    tableId = randomUUID(),
    team = randomUUID(),
    field = randomUUID(),
    fileField = randomUUID(),
    file = randomUUID();
  const revision = 'a'.repeat(40);
  const definition = {
    formatVersion: 2,
    id: tableId,
    owningTeamId: team,
    label: 'Retention receipts',
    fields: [
      { id: field, kind: 'text', label: 'Value', required: false, maxLength: 1000 },
      { id: fileField, kind: 'file', label: 'Evidence', required: false, cardinality: 'many', access: 'independent' },
    ],
    uniqueKeys: [],
  };
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Retention')`, [team]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) VALUES($1,'file','Evidence',$2,true,$3,1,'text/plain',$4)`,
    [file, ws.membershipId, randomUUID(), 'b'.repeat(64)],
  );
  const migration = await connect(db.login(ws, 'migration'));
  try {
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
      const tx = { client, schema: ws.names.schema };
      const generation = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
  } finally {
    await migration.end();
  }
  await db.platform.query(
    `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3 WHERE id=$1`,
    [tableId, revision, definition],
  );
  runtime = createWorkspaceRuntime({
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const requests = createRecordRequests(runtime);
  const cleanup = createTableCleanup({
    resolveMigrationCredential: async () => db.login(ws, 'migration'),
    batchRows: 1,
  });
  const drain = async () => {
    for (let i = 0; i < 30; i++) if ((await cleanup(ws.id)) === 'completed') return;
    assert.fail('Cleanup did not converge');
  };
  const createInput = {
    requestId: randomUUID(),
    mutation: {
      kind: 'create',
      tableId,
      revision,
      recordId: randomUUID(),
      values: {
        [field]: { kind: 'text', value: 'expired-private-value' },
        [fileField]: { kind: 'file', fileIds: [file] },
      },
    },
  };
  const created = await requests.mutate(ws.id, ws.userId, createInput);
  assert.equal(created.kind, 'available');
  assert.equal(created.values[field].value, 'expired-private-value');
  assert.deepEqual(
    await requests.mutate(ws.id, ws.userId, {
      ...createInput,
      mutation: {
        ...createInput.mutation,
        values: { [fileField]: createInput.mutation.values[fileField], [field]: createInput.mutation.values[field] },
      },
    }),
    created,
    'Canonical payload order does not change idempotency',
  );
  assert.deepEqual(await requests.status(ws.id, ws.userId, tableId, createInput.requestId), {
    status: 'applied',
    result: created,
  });
  assert.deepEqual(await requests.status(ws.id, ws.userId, tableId, randomUUID()), { status: 'unknown' });
  const deleteInput = {
    requestId: randomUUID(),
    mutation: { kind: 'delete', tableId, revision, recordId: created.id, expectedToken: created.token },
  };
  const deleted = await requests.mutate(ws.id, ws.userId, deleteInput);
  assert.deepEqual(deleted, { kind: 'available', id: created.id, token: deleted.token, values: null });
  await drain();
  assert.deepEqual(
    await requests.mutate(ws.id, ws.userId, createInput),
    created,
    'Unexpired outcome survives deleting the record and cleanup',
  );

  await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=now() WHERE id=$1`, [file]);
  assert.deepEqual(
    await requests.status(ws.id, ws.userId, tableId, createInput.requestId),
    { status: 'applied', result: created },
    'An unavailable file reference does not hide the receipt',
  );
  assert.deepEqual(await requests.mutate(ws.id, ws.userId, createInput), created);
  await db.platform.query(`UPDATE ${s}.tf_files SET deleting_at=clock_timestamp() WHERE id=$1`, [file]);
  await db.platform.query(`DELETE FROM ${s}.tf_files WHERE id=$1`, [file]);
  const recentInput = {
    requestId: randomUUID(),
    mutation: {
      kind: 'create',
      tableId,
      revision,
      recordId: randomUUID(),
      values: { [field]: { kind: 'text', value: 'recent-value' } },
    },
  };
  const recent = await requests.mutate(ws.id, ws.userId, recentInput);
  await db.platform.query(
    `UPDATE ${s}.tf_table_row_requests SET created_at=now()-interval '29 days' WHERE request_id=$1`,
    [recentInput.requestId],
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_row_requests SET created_at=now()-interval '31 days' WHERE request_id=ANY($1::uuid[])`,
    [[createInput.requestId, deleteInput.requestId]],
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_row_history_data SET created_at=now()-interval '31 days',recoverable_until=now()-interval '1 day' WHERE row_id=$1`,
    [created.id],
  );
  const history = (
    await db.platform.query(`SELECT id FROM ${s}.tf_table_row_history_data WHERE row_id=$1 AND operation='create'`, [
      created.id,
    ])
  ).rows[0];
  const holder = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
    history.id,
    holder,
  ]);
  const metadata = { kind: 'expired', id: created.id, token: created.token };
  assert.deepEqual(
    await requests.status(ws.id, ws.userId, tableId, createInput.requestId),
    { status: 'applied', result: metadata },
    'Expired values stay unavailable before cleanup, even when held',
  );
  await drain();
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::int n FROM ${s}.tf_table_row_requests WHERE input IS NOT NULL AND request_id=ANY($1::uuid[])`,
        [[createInput.requestId, deleteInput.requestId]],
      )
    ).rows[0].n,
    2,
    'Active record hold preserves receipt snapshots',
  );
  assert.equal(
    (await db.platform.query(`SELECT values FROM ${s}.tf_table_row_history_data WHERE id=$1`, [history.id])).rows[0]
      .values[field].value,
    'expired-private-value',
  );
  await db.platform.query(`DELETE FROM ${s}.tf_table_history_holds WHERE holder_id=$1`, [holder]);
  await drain();
  const stored = (
    await db.platform.query(`SELECT * FROM ${s}.tf_table_row_requests WHERE request_id=ANY($1::uuid[])`, [
      [createInput.requestId, deleteInput.requestId],
    ])
  ).rows;
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.equal(row.input, null);
    assert.deepEqual(row.result, {
      kind: 'expired',
      id: created.id,
      token: row.request_id === createInput.requestId ? created.token : deleted.token,
    });
    assert.equal(
      row.input_digest,
      tableProposalDigest(row.request_id === createInput.requestId ? createInput.mutation : deleteInput.mutation),
    );
  }
  const retainedHistory = (
    await db.platform.query(`SELECT * FROM ${s}.tf_table_row_history_data WHERE row_id=$1`, [created.id])
  ).rows;
  assert.equal(retainedHistory.length, 2);
  for (const row of retainedHistory) {
    assert.equal(row.values, null);
    assert.equal(row.before_values, null);
  }
  assert.equal(JSON.stringify([stored, retainedHistory]).includes('expired-private-value'), false);
  assert.equal(JSON.stringify(stored).includes(file), false);
  const beforeRetry = (
    await db.platform.query(
      `SELECT token,live,updated_at FROM ${s}.tf_table_identities WHERE table_id=$1 AND row_id=$2`,
      [tableId, created.id],
    )
  ).rows[0];
  assert.equal(beforeRetry.live, false);
  for (const result of await Promise.all(
    Array.from({ length: 3 }, () => requests.mutate(ws.id, ws.userId, createInput)),
  ))
    assert.deepEqual(result, metadata);
  assert.deepEqual(await requests.mutate(ws.id, ws.userId, deleteInput), {
    kind: 'expired',
    id: created.id,
    token: deleted.token,
  });
  await assert.rejects(
    requests.mutate(ws.id, ws.userId, {
      ...createInput,
      mutation: { ...createInput.mutation, values: { [field]: { kind: 'text', value: 'changed-payload' } } },
    }),
    error => error.code === 'idempotency-conflict',
  );
  assert.deepEqual(
    (
      await db.platform.query(
        `SELECT token,live,updated_at FROM ${s}.tf_table_identities WHERE table_id=$1 AND row_id=$2`,
        [tableId, created.id],
      )
    ).rows[0],
    beforeRetry,
  );
  assert.equal(
    (
      await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_row_history_data WHERE row_id=$1`, [
        created.id,
      ])
    ).rows[0].n,
    2,
    'Expired retry cannot append another mutation',
  );
  assert.deepEqual(await requests.mutate(ws.id, ws.userId, recentInput), recent);
  assert.deepEqual(await requests.status(ws.id, ws.userId, tableId, recentInput.requestId), {
    status: 'applied',
    result: recent,
  });
  assert.deepEqual(recordMutationResultSchema.parse(metadata), metadata);
  assert.deepEqual(recordRequestStatusSchema.parse({ status: 'applied', result: metadata }), {
    status: 'applied',
    result: metadata,
  });
  const runtimeClient = await connect(db.login(ws)),
    maintenanceClient = await connect(db.login(ws, 'migration'));
  try {
    await denied(runtimeClient, `UPDATE ${s}.tf_table_row_requests SET input=NULL`);
    await denied(runtimeClient, `DELETE FROM ${s}.tf_table_row_requests`);
    await denied(maintenanceClient, `UPDATE ${s}.tf_table_row_requests SET input_digest=$1`, ['0'.repeat(64)]);
    await denied(maintenanceClient, `DELETE FROM ${s}.tf_table_row_requests`);
  } finally {
    await runtimeClient.end();
    await maintenanceClient.end();
  }
  await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [ws.membershipId]);
  await assert.rejects(requests.status(ws.id, ws.userId, tableId, createInput.requestId), AccessDenied);
  await assert.rejects(requests.mutate(ws.id, ws.userId, createInput), AccessDenied);
});
