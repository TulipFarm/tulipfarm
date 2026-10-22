import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { fixture, connect, denied, markWorkspaceReady } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createGeneration, activateGeneration, generationProposalData } from '../../../tables/dist/store.js';
import { createTableService } from '../../../tables/dist/service.js';
import { executionCompatibility } from '../../../tables/dist/execution.js';
import {
  createTableProposals,
  createTableProposalDecisions,
  tableProposalDigest,
} from '../../../tables/dist/proposals.js';
import { proposalViewSchema } from '../../../tables/dist/proposal-contracts.js';
import { createTableCleanup } from '../../../tables/dist/cleanup.js';
import { createTableExecution } from '../../../tables/dist/execution.js';
import { createTableImports, createTableImportObjectCleanup } from '../../../tables/dist/imports.js';
import { createTableSchemaHistory } from '../../../../apps/api/src/table-schema-history.ts';
import { createObjectCleanupSweep } from '../../../../apps/worker/src/table-cleanup.ts';
import { commonCompatibility } from '../../../workspaces/src/storage.ts';

test('retention removes exact proposal copies, preserves holds and audit, and retries import-only object deletion', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const migrations = await workspaceTableMigrations();
  assert.equal(migrations.length, commonCompatibility.maximum);
  const w = await db.create(migrations),
    s = `"${w.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const chat = randomUUID(),
    turn = randomUUID(),
    message = randomUUID(),
    team = randomUUID(),
    field = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Retention')`, [team]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    chat,
    actor.userId,
    actor.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, chat, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,0,'text','source-history-kept')`,
    [chat, message],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  const origin = { conversationId: chat, turnId: turn, sources: [] },
    revision = 'a'.repeat(40);
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'Retention',
    fields: [{ id: field, kind: 'text', label: 'Key', required: false, maxLength: 1000 }],
    uniqueKeys: [{ id: randomUUID(), fieldIds: [field], nulls: 'distinct' }],
  };
  const migration = await connect(db.login(w, 'migration'));
  try {
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
  } finally {
    await migration.end();
  }
  await db.platform.query(
    `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3 WHERE id=$1`,
    [definition.id, revision, definition],
  );
  const service = createTableService(
    runtime,
    { readableFiles: async () => assert.fail('Unexpected file') },
    executionCompatibility,
  );
  const text = value => ({ kind: 'text', value });
  const row = await service.mutate(w.id, actor, {
    kind: 'create',
    tableId: definition.id,
    revision,
    recordId: randomUUID(),
    values: { [field]: text('retention-secret-before') },
  });
  const root = await mkdtemp(join(tmpdir(), 'table-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Set();
  let failRemoval = false,
    failWrite = false;
  const removed = [];
  const bytes = {
    putIfAbsent: async (key, value) => {
      if (failWrite && key.endsWith('.length')) throw new Error('partial-object-write');
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, value, { flag: 'wx' });
        objects.add(key);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    },
    read: async (key, length) => {
      const value = await readFile(join(root, key));
      assert.equal(value.length, length);
      return value;
    },
    remove: async key => {
      removed.push(key);
      if (failRemoval && key.endsWith('.length')) throw new Error('object-delete-failed');
      await rm(join(root, key), { force: true });
      objects.delete(key);
    },
  };
  const imports = createTableImports({ attachments: bytes, snapshots: bytes, requireSources: async () => {} });
  const options = { runtime, data: generationProposalData, requireSources: async () => {}, imports };
  const proposals = createTableProposals(options);
  const decisions = createTableProposalDecisions({
    ...options,
    resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
  });
  const propose = plans => proposals.propose(w.id, actor, randomUUID(), origin, { plans });
  const plan = {
    kind: 'records',
    tableId: definition.id,
    expectedRevision: revision,
    dependsOn: [],
    changes: [{ kind: 'update', recordId: row.id, values: { [field]: text('retention-secret-after') } }],
  };
  const recordProposal = await propose([plan]);
  await decisions.decide(w.id, w.userId, chat, recordProposal.id, {
    commandId: randomUUID(),
    digest: recordProposal.digest,
    decision: 'approve',
  });
  await decisions.control(w.id, w.userId, chat, recordProposal.id, {
    commandId: randomUUID(),
    digest: recordProposal.digest,
    operation: 'cancel',
  });
  const resultId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,sequence,tool,status) VALUES($1,$2,$3,1,'github.issue.read','running')`,
    [resultId, chat, turn],
  );
  const reference = await imports.captureIntegration(
    runtime,
    { workspaceId: w.id, actor, origin, resultId, tool: 'github.issue.read' },
    { format: 'object', path: [], columns: ['key'], conversions: {}, empty: 'null' },
    async () => ({
      result: { key: 'retention-secret-import' },
      sources: [
        { kind: 'github-source', integrationId: randomUUID(), sourceId: randomUUID(), generation: 1, grantsVersion: 1 },
      ],
    }),
  );
  await db.platform.query(`UPDATE ${s}.tf_conversation_tool_calls SET status='completed' WHERE id=$1`, [resultId]);
  const importProposal = await propose([
    {
      kind: 'import',
      tableId: definition.id,
      expectedRevision: revision,
      dependsOn: [],
      reference,
      matchFieldIds: [field],
      mappings: [{ sourceColumn: 'key', fieldId: field }],
    },
  ]);
  const schemaProposal = await propose([
    {
      kind: 'schema',
      tableId: definition.id,
      expectedRevision: revision,
      dependsOn: [],
      target: definition,
      transforms: {
        outputs: [{ fieldId: field, expression: { op: 'literal', value: text('retention-secret-transform') } }],
      },
    },
  ]);
  const recent = await propose([plan]);
  await decisions.decide(w.id, w.userId, chat, recent.id, {
    commandId: randomUUID(),
    digest: recent.digest,
    decision: 'approve',
  });
  const recentJob = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_executions(proposal_id,table_id,id,publication_id,phase) VALUES($1,$2,$3,$4,'copying')`,
    [recent.id, definition.id, recentJob, randomUUID()],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_executions(proposal_id,table_id,id,publication_id,phase) VALUES($1,$2,$3,$4,'blocked')`,
    [schemaProposal.id, definition.id, randomUUID(), randomUUID()],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields,key_id,key_value,created_at) VALUES($1,$2,false,'{}',$3,'"retention-secret-capture"',now()-interval '32 days')`,
    [definition.id, row.id, definition.uniqueKeys[0].id],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields,key_id,key_value,created_at) VALUES($1,$2,false,'{}',$3,'"retention-secret-orphan"',now()-interval '32 days')`,
    [randomUUID(), randomUUID(), randomUUID()],
  );
  const ids = [recordProposal.id, importProposal.id, schemaProposal.id];
  const completedReceipt = { status: 'completed', executionId: randomUUID(), revision };
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_proposal_receipts(proposal_id,table_id,attempt,receipt) VALUES($1,$2,0,$3)`,
    [importProposal.id, definition.id, completedReceipt],
  );
  const attachmentId = randomUUID(),
    attachmentKey = `${w.id}/${randomUUID()}`,
    source = Buffer.from('key\nsource-attachment-kept\n');
  const fileReference = {
    kind: 'file',
    attachmentId,
    contentDigest: createHash('sha256').update(source).digest('hex'),
  };
  await bytes.putIfAbsent(attachmentKey, source);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_attachments(id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id) VALUES($1,$2,$3,$4,'source.csv','text/csv',$5,$6,'bound',$7)`,
    [
      attachmentId,
      chat,
      actor.membershipId,
      attachmentKey.split('/')[1],
      source.length,
      fileReference.contentDigest,
      message,
    ],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,attachment_id) VALUES($1,$2,1,'attachment',$3)`,
    [chat, message, attachmentId],
  );
  await imports.prepareFile(runtime, w.id, actor, origin, fileReference, {
    format: 'csv',
    delimiter: ',',
    header: { kind: 'row', row: 1 },
    conversions: {},
    empty: 'null',
  });
  const partialId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,sequence,tool,status) VALUES($1,$2,$3,2,'github.issue.read','running')`,
    [partialId, chat, turn],
  );
  failWrite = true;
  await assert.rejects(
    imports.captureIntegration(
      runtime,
      { workspaceId: w.id, actor, origin, resultId: partialId, tool: 'github.issue.read' },
      { format: 'object', path: [], columns: ['key'], conversions: {}, empty: 'null' },
      async () => ({
        result: { key: 'retention-secret-partial-write' },
        sources: [
          {
            kind: 'github-source',
            integrationId: randomUUID(),
            sourceId: randomUUID(),
            generation: 1,
            grantsVersion: 1,
          },
        ],
      }),
    ),
    /import-unavailable/,
  );
  failWrite = false;
  const partial = (
    await db.platform.query(`SELECT object_key FROM ${s}.tf_table_import_objects WHERE reference_id=$1`, [partialId])
  ).rows[0];
  assert.ok(partial, 'Reservation survives the failed object transaction');
  assert.equal(objects.has(partial.object_key), true);
  assert.equal(objects.has(`${partial.object_key}.length`), false);
  const originals = (
    await db.platform.query(`SELECT id,digest,input_digest FROM ${s}.tf_table_proposals WHERE id=ANY($1::uuid[])`, [
      ids,
    ])
  ).rows;
  const age = async () => {
    await db.platform.query(
      `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '33 days',expires_at=now()-interval '32 days' WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    for (const name of [
      'tf_table_proposal_decisions',
      'tf_table_proposal_controls',
      'tf_table_proposal_receipts',
      'tf_table_executions',
    ])
      await db.platform.query(
        `UPDATE ${s}.${name} SET created_at=now()-interval '32 days' WHERE proposal_id=ANY($1::uuid[])`,
        [ids],
      );
    await db.platform.query(`UPDATE ${s}.tf_table_proposal_changes SET created_at=now()-interval '32 days'`);
    await db.platform.query(
      `UPDATE ${s}.tf_table_import_objects SET created_at=now()-interval '32 days',last_used_at=now()-interval '32 days'`,
    );
  };
  await age();
  const cleanup = createTableCleanup({
    resolveMigrationCredential: async () => db.login(w, 'migration'),
    batchRows: 1,
  });
  const cleanupObjects = createTableImportObjectCleanup(runtime, bytes);
  const drain = async () => {
    for (let i = 0; i < 100; i++) if ((await cleanup(w.id)) === 'completed') return;
    assert.fail('Cleanup did not converge');
  };
  await drain();
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::int n FROM ${s}.tf_table_proposal_changes WHERE key_value='"retention-secret-orphan"'::jsonb`,
      )
    ).rows[0].n,
    0,
    'Unreferenced aged capture value purged',
  );
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::int n FROM ${s}.tf_table_proposal_changes WHERE key_value='"retention-secret-capture"'::jsonb`,
      )
    ).rows[0].n,
    1,
    'Active capture keeps invalidation evidence',
  );
  assert.equal(
    (await db.platform.query(`SELECT redacted_at FROM ${s}.tf_table_proposals WHERE id=$1`, [recordProposal.id]))
      .rows[0].redacted_at,
    null,
    'Unexpired record recovery holds affected proposals',
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_row_history_data SET created_at=now()-interval '32 days',recoverable_until=now()-interval '2 days'`,
  );
  const history = (await db.platform.query(`SELECT id FROM ${s}.tf_table_row_history_data LIMIT 1`)).rows[0].id;
  const holder = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
    history,
    holder,
  ]);
  await drain();
  assert.equal(
    (await db.platform.query(`SELECT redacted_at FROM ${s}.tf_table_proposals WHERE id=$1`, [recordProposal.id]))
      .rows[0].redacted_at,
    null,
    'Explicit recovery hold preserves affected copies',
  );
  await db.platform.query(`DELETE FROM ${s}.tf_table_history_holds WHERE holder_id=$1`, [holder]);
  const recentBefore = (
    await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [recent.id])
  ).rows[0].manifest;
  const activeMaintenance = await connect(db.login(w, 'migration'));
  try {
    await assert.rejects(
      activeMaintenance.query(`UPDATE ${s}.tf_table_proposals SET manifest=manifest WHERE id=$1`, [recent.id]),
      /proposal-retention-conflict/,
    );
  } finally {
    await activeMaintenance.end();
  }
  await drain();
  assert.deepEqual(
    (await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [recent.id])).rows[0].manifest,
    recentBefore,
  );
  assert.ok(objects.size, 'Unfinished conversation work holds import objects');
  await db.platform.query(
    `UPDATE ${s}.tf_conversation_turns SET status='completed',response_message_id=$2 WHERE id=$1`,
    [turn, message],
  );
  await drain();
  failRemoval = true;
  await assert.rejects(cleanupObjects(w.id), /object-delete-failed/);
  const pending = (
    await db.platform.query(`SELECT * FROM ${s}.tf_table_import_objects WHERE cleanup_pending_at IS NOT NULL`)
  ).rows[0];
  assert.ok(pending.cleanup_pending_at);
  assert.equal(pending.removed_at, null);
  assert.equal(objects.has(pending.object_key), false, 'Payload removed before failed sidecar delete');
  assert.equal(objects.has(`${pending.object_key}.length`), true);
  await assert.rejects(
    runtime.transaction(w.id, executionCompatibility, tx =>
      imports.readSnapshot(tx, actor, origin, pending.kind === 'file' ? fileReference : reference),
    ),
    /snapshot-unavailable/,
  );
  failRemoval = false;
  await markWorkspaceReady(db.platform, w.id);
  const priorRegistry = process.env.WORKSPACE_AUTHORING_DATABASE_URL;
  process.env.WORKSPACE_AUTHORING_DATABASE_URL = db.connectionString;
  const sweep = createObjectCleanupSweep(runtime, bytes);
  if (priorRegistry === undefined) delete process.env.WORKSPACE_AUTHORING_DATABASE_URL;
  else process.env.WORKSPACE_AUTHORING_DATABASE_URL = priorRegistry;
  try {
    await sweep.sweep();
  } finally {
    await sweep.close();
  }
  assert.equal(await cleanupObjects(w.id), 'completed');
  assert.deepEqual([...objects], [attachmentKey]);
  assert.deepEqual(await bytes.read(attachmentKey, source.length), source, 'Source attachment is not import-owned');
  assert.equal(removed.includes(attachmentKey), false);
  assert.ok((await db.platform.query(`SELECT removed_at FROM ${s}.tf_table_import_objects`)).rows[0].removed_at);
  assert.equal(removed.filter(key => key === pending.object_key).length, 2, 'Restart retries idempotent deletion');
  for (const original of originals) {
    const stored = (await db.platform.query(`SELECT * FROM ${s}.tf_table_proposals WHERE id=$1`, [original.id]))
      .rows[0];
    assert.equal(stored.digest, original.digest);
    assert.equal(stored.input_digest, original.input_digest);
    assert.equal(tableProposalDigest(stored.manifest), stored.redacted_digest);
    const review = proposalViewSchema.parse(await proposals.read(w.id, w.userId, chat, original.id));
    assert.equal(review.content, 'redacted');
    assert.equal(review.manifest.originalDigest, original.digest);
    assert.equal(review.manifest.requester.membershipId, actor.membershipId);
    assert.ok(review.manifest.plans[0].fieldIds.includes(field));
    assert.equal(JSON.stringify(stored).includes('retention-secret'), false);
    await assert.rejects(
      decisions.decide(w.id, w.userId, chat, original.id, {
        commandId: randomUUID(),
        digest: original.digest,
        decision: 'approve',
      }),
      /proposal-redacted/,
    );
    await assert.rejects(
      decisions.control(w.id, w.userId, chat, original.id, {
        commandId: randomUUID(),
        digest: original.digest,
        operation: 'resume',
      }),
      /proposal-redacted/,
    );
    await assert.rejects(proposals.effects(w.id, w.userId, chat, original.id, definition.id, {}), /proposal-redacted/);
    const advance = createTableExecution({
      resolveMigrationCredential: async () => db.login(w, 'migration'),
      requireSources: async () => {},
      requireFiles: async () => {},
      requireImportReference: async () => {},
    });
    assert.equal(await advance(w.id, original.id), 'blocked');
  }
  for (const name of [
    'tf_table_proposal_effects',
    'tf_table_proposal_matches',
    'tf_table_proposal_freshness',
    'tf_table_proposal_capture',
  ]) {
    const copies = (await db.platform.query(`SELECT * FROM ${s}.${name} WHERE proposal_id=ANY($1::uuid[])`, [ids]))
      .rows;
    assert.equal(JSON.stringify(copies).includes('retention-secret'), false, name);
    if (name === 'tf_table_proposal_effects') {
      assert.ok(copies.length);
      for (const copy of copies) {
        assert.equal(copy.effect.redacted, true);
        assert.ok(copy.effect.recordId);
        assert.ok(copy.effect.fieldIds.includes(field));
      }
    } else assert.equal(copies.length, 0, name);
  }
  const schemaHistory = await createTableSchemaHistory(options).history(w.id, w.userId, definition.id, { limit: 10 });
  assert.equal(schemaHistory.entries.length, 1);
  assert.equal(schemaHistory.entries[0].definition, null, 'Schema history accepts the redacted manifest');
  const completedReview = await proposals.read(w.id, w.userId, chat, importProposal.id);
  assert.equal(completedReview.status, 'completed');
  assert.deepEqual(completedReview.plans[0].receipt, completedReceipt, 'Completion outcome survives value deletion');
  await db.platform.query(
    `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '33 days',expires_at=now()-interval '32 days' WHERE id=$1`,
    [recent.id],
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_proposal_decisions SET created_at=now()-interval '32 days' WHERE proposal_id=$1`,
    [recent.id],
  );
  await db.platform.query(`UPDATE ${s}.tf_table_executions SET created_at=now()-interval '32 days' WHERE id=$1`, [
    recentJob,
  ]);
  await drain();
  assert.equal(
    (await db.platform.query(`SELECT phase,error_code FROM ${s}.tf_table_executions WHERE id=$1`, [recentJob])).rows[0]
      .error_code,
    'proposal-redacted',
    'Expired abandoned copying job closes',
  );
  assert.equal(
    (await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_proposal_changes`)).rows[0].n,
    0,
    'No retained raw capture keys after the last live reference closes',
  );
  assert.equal(
    (
      await db.platform.query(`SELECT text FROM ${s}.tf_conversation_parts WHERE message_id=$1 AND kind='text'`, [
        message,
      ])
    ).rows[0].text,
    'source-history-kept',
  );
  const runtimeClient = await connect(db.login(w)),
    maintenanceClient = await connect(db.login(w, 'migration'));
  try {
    await denied(runtimeClient, `UPDATE ${s}.tf_table_proposals SET redacted_at=now()`);
    await denied(maintenanceClient, `UPDATE ${s}.tf_table_proposals SET digest=$1`, ['0'.repeat(64)]);
    await denied(maintenanceClient, `DELETE FROM ${s}.tf_table_proposals`);
    await assert.rejects(
      maintenanceClient.query(`UPDATE ${s}.tf_table_proposals SET manifest=manifest WHERE id=$1`, [recent.id]),
      /proposal-retention-conflict/,
    );
  } finally {
    await runtimeClient.end();
    await maintenanceClient.end();
  }
});
