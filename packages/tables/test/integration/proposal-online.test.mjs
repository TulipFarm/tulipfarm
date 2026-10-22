/* oxlint-disable tulipfarm/product-copy -- Internal test fixtures and measurements. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { requireDraftSources } from '../../../agents/src/draft-sources.ts';
import { createTableService } from '../../../tables/dist/service.js';
import { executionCompatibility } from '../../../tables/dist/execution.js';
import { createGeneration, activateGeneration, generationProposalData } from '../../../tables/dist/store.js';
import { createTableProposals, createTableProposalDecisions } from '../../../tables/dist/proposals.js';
import { requireProposalCaptureCurrent } from '../../../tables/dist/proposal-data.js';
import { TableProposalValidationError } from '../../../tables/dist/proposal-contracts.js';
import { createChatTools } from '../../../agents/src/tools.ts';
import { tableProposalOptions } from '../../../agents/src/table-proposals.ts';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationExecutor } from '../../../conversations/src/runtime.ts';
import { commonCompatibility } from '../../../workspaces/src/storage.ts';

const text = value => ({ kind: 'text', value });
async function setup(t) {
  const db = await fixture();
  let runtime, client;
  t.after(async () => {
    await runtime?.close();
    await client?.end();
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
    connectionsPerPool: 3,
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  client = await connect(db.login(w, 'migration'));
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const chat = randomUUID(),
    turn = randomUUID(),
    message = randomUUID(),
    team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Proposal fixture')`, [team]);
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
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  const key = randomUUID(),
    title = randomUUID(),
    notes = randomUUID(),
    revision = 'a'.repeat(40);
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'Tickets',
    fields: [key, title, notes].map(id => ({ id, kind: 'text', label: 'Field', required: false, maxLength: 1000 })),
    uniqueKeys: [{ id: randomUUID(), fieldIds: [key], nulls: 'distinct' }],
  };
  let generation;
  await inTransaction(client, async client => {
    await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
    const tx = { client, schema: w.names.schema };
    generation = await createGeneration(tx, { definition, revision });
    await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
  });
  await db.platform.query(
    `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3 WHERE id=$1`,
    [definition.id, revision, definition],
  );
  const service = createTableService(
    runtime,
    { readableFiles: async () => assert.fail('Unexpected file') },
    executionCompatibility,
  );
  const origin = { conversationId: chat, turnId: turn, sources: [] };
  const options = { runtime, data: generationProposalData, requireSources: requireDraftSources };
  const proposals = createTableProposals(options);
  const decisions = createTableProposalDecisions({
    ...options,
    resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
  });
  const propose = (plan, service = proposals) => service.propose(w.id, actor, randomUUID(), origin, { plans: [plan] });
  const approve = (proposal, service = decisions) =>
    service.decide(w.id, actor.userId, chat, proposal.id, {
      commandId: randomUUID(),
      decision: 'approve',
      digest: proposal.digest,
    });
  const read = id => service.read(w.id, actor, { tableId: definition.id, revision, recordId: id });
  const create = values =>
    service.mutate(w.id, actor, { kind: 'create', tableId: definition.id, revision, recordId: randomUUID(), values });
  const update = async (id, values) =>
    service.mutate(w.id, actor, {
      kind: 'update',
      tableId: definition.id,
      revision,
      recordId: id,
      expectedToken: (await read(id)).token,
      values,
    });
  const capture = proposal =>
    runtime.transaction(w.id, executionCompatibility, async tx => {
      await generationProposalData.lock(tx, [definition.id]);
      await requireProposalCaptureCurrent(tx, proposal.id, definition.id);
    });
  return {
    db,
    w,
    s,
    runtime,
    client,
    actor,
    chat,
    turn,
    team,
    key,
    title,
    notes,
    definition,
    revision,
    generation,
    options,
    proposals,
    decisions,
    propose,
    approve,
    read,
    create,
    update,
    capture,
    service,
  };
}

test('online optimistic preview rejects mixed versions and permits reads and unrelated writes', async t => {
  const f = await setup(t);
  const row = await f.create({ [f.key]: text('key'), [f.title]: text(' open '), [f.notes]: text('initial') });
  const plan = {
    kind: 'schema',
    tableId: f.definition.id,
    expectedRevision: f.revision,
    dependsOn: [],
    target: f.definition,
    transforms: {
      outputs: [{ fieldId: f.title, expression: { op: 'trim', input: { op: 'field', fieldId: f.title } } }],
    },
  };
  let afterRead = async () => {};
  const data = {
    ...generationProposalData,
    records: async (...args) => {
      const rows = await generationProposalData.records(...args);
      if (rows.length) await afterRead();
      return rows;
    },
  };
  const proposals = createTableProposals({ ...f.options, data });
  afterRead = async () => {
    const start = performance.now();
    assert.equal((await f.read(row.id)).id, row.id);
    await f.update(row.id, { [f.notes]: text('during preview') });
    t.diagnostic(JSON.stringify({ phase: 'preview', concurrentReadWriteMs: Math.round(performance.now() - start) }));
  };
  const online = await f.propose(plan, proposals);
  // Sources run again inside the final fence; only the first call probes online IO.
  let calls = 0;
  const onlineDecisions = createTableProposalDecisions({
    ...f.options,
    data: { ...generationProposalData, records: async () => assert.fail('Approval rescanned records') },
    requireSources: async (...args) => {
      await requireDraftSources(...args);
      if (++calls === 1) {
        await f.read(row.id);
        await f.update(row.id, { [f.notes]: text('during approval') });
      }
    },
    resolveConfirmationCredential: async () => f.db.login(f.w, 'confirmation'),
  });
  assert.equal((await f.approve(online, onlineDecisions)).status, 'approved');
  afterRead = () => f.update(row.id, { [f.title]: text(' open ') });
  await assert.rejects(f.propose(plan, proposals), /proposal-stale/);
  const fresh = await f.propose(plan);
  await f.update(row.id, { [f.title]: text('temporary') });
  await f.update(row.id, { [f.title]: text(' open ') });
  await assert.rejects(f.approve(fresh), /proposal-stale/);
  // The writer starts before the snapshot and commits after the scan. Its xid
  // must be considered, even though it precedes any sequence high-water mark.
  const writer = await connect(f.db.login(f.w));
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT pg_current_xact_id()');
    afterRead = async () => {
      await writer.query(
        `UPDATE ${f.s}.tf_table_identities SET field_versions=field_versions || jsonb_build_object($1::text,gen_random_uuid()) WHERE table_id=$2 AND row_id=$3`,
        [f.title, f.definition.id, row.id],
      );
      await writer.query('COMMIT');
    };
    await assert.rejects(f.propose(plan, proposals), /proposal-stale/);
  } finally {
    await writer.end();
  }
});

test('import retains zero-effect matches, source mapping and scoped freshness through approval', async t => {
  const f = await setup(t);
  let row = await f.create({ [f.key]: text('key'), [f.title]: text('same'), [f.notes]: text('initial') });
  const resultId = randomUUID(),
    digest = 'b'.repeat(64);
  await f.db.platform.query(
    `INSERT INTO ${f.s}.tf_conversation_tool_calls(id,conversation_id,turn_id,tool,status,sequence) VALUES($1,$2,$3,'google.read','completed',1)`,
    [resultId, f.chat, f.turn],
  );
  const source = { kind: 'private-conversation', conversationId: f.chat };
  let rows = [{ key: text('key'), title: text('same') }];
  const options = {
    ...f.options,
    imports: { readSnapshot: async () => ({ contentDigest: digest, sources: [source], rows }) },
  };
  const proposals = createTableProposals(options);
  const plan = {
    kind: 'import',
    tableId: f.definition.id,
    expectedRevision: f.revision,
    dependsOn: [],
    reference: { kind: 'integration', resultId, contentDigest: digest },
    matchFieldIds: [f.key],
    mappings: [
      { sourceColumn: 'key', fieldId: f.key },
      { sourceColumn: 'title', fieldId: f.title },
    ],
  };
  const propose = () => f.propose(plan, proposals);
  const proposal = await propose();
  const stored = (
    await f.db.platform.query(`SELECT * FROM ${f.s}.tf_table_proposal_matches WHERE proposal_id=$1`, [proposal.id])
  ).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].row_id, row.id);
  assert.equal(stored[0].source_index, 0);
  assert.equal(stored[0].matched, true);
  assert.deepEqual(stored[0].mapped, { [f.key]: text('key'), [f.title]: text('same') });
  const fresh = (
    await f.db.platform.query(`SELECT snapshot FROM ${f.s}.tf_table_proposal_freshness WHERE proposal_id=$1`, [
      proposal.id,
    ])
  ).rows;
  assert.equal(fresh.length, 1);
  assert.deepEqual(Object.keys(fresh[0].snapshot.fields).sort(), [f.key, f.title].sort());
  assert.equal((await proposals.read(f.w.id, f.actor.userId, f.chat, proposal.id)).manifest.plans[0].effectCount, 0);
  await f.update(row.id, { [f.notes]: text('unrelated') });
  await f.create({ [f.key]: text('unrelated'), [f.title]: text('other') });
  await f.approve(proposal);
  await f.capture(proposal);
  await f.update(row.id, { [f.title]: text('same') });
  await assert.rejects(f.capture(proposal), /proposal-stale/);
  await assert.rejects(
    f.db.platform.query(
      `INSERT INTO ${f.s}.tf_table_proposal_receipts(proposal_id,table_id,attempt,receipt) VALUES($1,$2,0,$3)`,
      [proposal.id, f.definition.id, { status: 'completed', executionId: randomUUID(), revision: f.revision }],
    ),
    /proposal-stale/,
  );

  const changedMatch = await propose();
  await f.approve(changedMatch);
  await f.update(row.id, { [f.key]: text('moved') });
  await f.create({ [f.key]: text('key'), [f.title]: text('same') });
  await assert.rejects(f.capture(changedMatch), /proposal-stale/);

  rows = [{ key: text('moved'), title: text('same') }];
  const restored = await propose();
  await f.approve(restored);
  const history = (await f.service.history(f.w.id, f.actor, { tableId: f.definition.id, recordId: row.id })).find(
    item => item.operation === 'create',
  );
  row = await f.read(row.id);
  row = await f.service.mutate(f.w.id, f.actor, {
    kind: 'delete',
    tableId: f.definition.id,
    revision: f.revision,
    recordId: row.id,
    expectedToken: row.token,
  });
  await assert.rejects(f.capture(restored), /proposal-stale/);
  const replacement = (
    await f.db.platform.query(`SELECT row_id FROM ${f.s}.tf_table_unique_values WHERE generation_id=$1 AND value=$2`, [
      f.generation.id,
      JSON.stringify(['key']),
    ])
  ).rows[0].row_id;
  const replacementRow = await f.read(replacement);
  await f.service.mutate(f.w.id, f.actor, {
    kind: 'delete',
    tableId: f.definition.id,
    revision: f.revision,
    recordId: replacement,
    expectedToken: replacementRow.token,
  });
  await f.service.mutate(f.w.id, f.actor, {
    kind: 'restore',
    tableId: f.definition.id,
    revision: f.revision,
    recordId: row.id,
    expectedToken: row.token,
    historyId: history.id,
  });
  await assert.rejects(f.capture(restored), /proposal-stale/);
  rows = [
    { key: text('key'), title: text('same') },
    { key: text('key'), title: text('same') },
  ];
  await assert.rejects(propose(), /invalid-import/);
  rows = [{ key: text('absent'), title: text('new') }];
  const absent = await propose();
  await f.approve(absent);
  await f.create({ [f.key]: text('absent'), [f.title]: text('new') });
  await assert.rejects(f.capture(absent), /proposal-stale/);
});

test('100000-row preview and approval allow real concurrent service reads and writes', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const count = 100000;
  const column = id => `"f_${id.replaceAll('-', '')}"`;
  await f.db.platform.query(
    `INSERT INTO ${f.s}."${f.generation.physical_table}"(id,token,${column(f.title)},${column(f.notes)}) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),'  fixture  ','initial' FROM generate_series(1,$1) i`,
    [count],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) SELECT $1,id,token,token,jsonb_build_object($2::text,token,$3::text,token),true FROM ${f.s}."${f.generation.physical_table}"`,
    [f.definition.id, f.title, f.notes],
  );
  await f.db.platform.query(`ANALYZE ${f.s}.tf_table_identities; ANALYZE ${f.s}.tf_table_proposal_changes`);
  const first = '00000000-0000-4000-8000-000000000001',
    last = '00000000-0000-4000-8000-000000100000';
  const plan = {
    kind: 'schema',
    tableId: f.definition.id,
    expectedRevision: f.revision,
    dependsOn: [],
    target: f.definition,
    transforms: {
      outputs: [{ fieldId: f.title, expression: { op: 'trim', input: { op: 'field', fieldId: f.title } } }],
    },
  };
  const measure = async (phase, action) => {
    let done = false,
      writes = 0,
      reads = 0,
      maxReadWriteMs = 0;
    const start = performance.now();
    const operation = action().finally(() => {
      done = true;
    });
    const traffic = (async () => {
      while (!done) {
        const tick = performance.now();
        await f.read(first);
        reads++;
        await f.update(last, { [f.notes]: text(`${phase}-${writes}`) });
        writes++;
        maxReadWriteMs = Math.max(maxReadWriteMs, performance.now() - tick);
      }
    })();
    const [result] = await Promise.all([operation, traffic]);
    assert.ok(reads > 0 && writes > 0);
    t.diagnostic(
      JSON.stringify({
        phase,
        rows: count,
        ms: Math.round(performance.now() - start),
        reads,
        writes,
        maxReadWriteMs: Math.round(maxReadWriteMs),
      }),
    );
    return result;
  };
  const proposal = await measure('preview', () => f.propose(plan));
  const counts = (
    await f.db.platform.query(
      `SELECT (SELECT count(*)::int FROM ${f.s}.tf_table_proposal_effects WHERE proposal_id=$1) effects,(SELECT count(*)::int FROM ${f.s}.tf_table_proposal_freshness WHERE proposal_id=$1) freshness`,
      [proposal.id],
    )
  ).rows[0];
  assert.deepEqual(counts, { effects: count, freshness: count });
  assert.equal((await measure('approval', () => f.approve(proposal))).status, 'approved');
  await f.capture(proposal);
  await f.update(first, { [f.title]: text('  changed  ') });
  await assert.rejects(f.capture(proposal), /proposal-stale/);
});

test('blocked conversion previews report bounded exact identities without saving or changing data, and correction can be proposed', async t => {
  const f = await setup(t);
  const count = 1001;
  const column = id => `"f_${id.replaceAll('-', '')}"`;
  await f.db.platform.query(
    `INSERT INTO ${f.s}."${f.generation.physical_table}"(id,token,${column(f.title)}) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),'private-invalid-number' FROM generate_series(1,$1) i`,
    [count],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) SELECT $1,id,token,token,jsonb_build_object($2::text,token),true FROM ${f.s}."${f.generation.physical_table}"`,
    [f.definition.id, f.title],
  );
  const plan = {
    kind: 'schema',
    tableId: f.definition.id,
    expectedRevision: f.revision,
    dependsOn: [],
    target: {
      ...f.definition,
      fields: f.definition.fields.map(field =>
        field.id === f.title
          ? { id: f.title, label: 'Amount', kind: 'numeric', required: false, precision: 30, scale: 10 }
          : field,
      ),
    },
    transforms: {
      outputs: [
        {
          fieldId: f.title,
          expression: {
            op: 'convert',
            input: { op: 'field', fieldId: f.title },
            to: 'numeric',
            timezone: 'UTC',
            onError: 'error',
          },
        },
      ],
    },
  };
  const records = Array.from({ length: 100 }, (_, index) => ({
    recordId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    fieldId: f.title,
    code: 'conversion-failed',
  }));
  const snapshot = async () =>
    (
      await f.db.platform.query(
        `SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM ${f.s}."${f.generation.physical_table}" r`,
      )
    ).rows[0].rows;
  const before = await snapshot();
  const catalog = async () =>
    (await f.db.platform.query(`SELECT * FROM ${f.s}.tf_table_catalog WHERE id=$1`, [f.definition.id])).rows;
  const originalCatalog = await catalog();
  const authoring = async () =>
    (
      await f.db.platform.query(
        `SELECT (SELECT count(*)::int FROM ${f.s}.tf_table_proposals) proposals,(SELECT count(*)::int FROM ${f.s}.tf_table_proposal_effects) effects,(SELECT count(*)::int FROM ${f.s}.tf_table_proposal_receipts) receipts,(SELECT count(*)::int FROM ${f.s}.tf_authoring_commands) commands,(SELECT count(*)::int FROM ${f.s}.tf_soul_revisions) soul`,
      )
    ).rows[0];
  const originalAuthoring = await authoring();
  let validation;
  await assert.rejects(f.propose(plan), error => {
    assert.ok(error instanceof TableProposalValidationError);
    validation = error.validation;
    assert.equal(validation.status, 'blocked');
    assert.equal(validation.error, 'invalid-transform');
    assert.equal(validation.tableId, f.definition.id);
    assert.equal(validation.revision, f.revision);
    assert.equal(validation.total, count);
    assert.equal(validation.truncated, true);
    assert.deepEqual(validation.records, records);
    assert.equal(JSON.stringify(validation).includes('private-invalid-number'), false);
    return true;
  });
  const origin = { conversationId: f.chat, turnId: f.turn, sources: [] };
  const context = { workspaceId: f.w.id, actor: f.actor, callId: randomUUID(), origin };
  const call = { tool: 'tables.propose', input: JSON.stringify({ plans: [plan] }) };
  const tools = createChatTools(f.runtime);
  const result = await tools.invokeWithSources(context, call);
  assert.deepEqual(result.result, validation);
  assert.deepEqual(result.sources, [{ kind: 'table-rows', tableId: f.definition.id, revision: f.revision }]);
  assert.match(result.result.instruction, /ask how to correct/);
  assert.ok(JSON.stringify(result).length < 96000);
  assert.deepEqual(await authoring(), originalAuthoring);
  assert.deepEqual(await catalog(), originalCatalog);
  assert.deepEqual(await snapshot(), before);
  await f.db.platform.query(
    `INSERT INTO ${f.s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) SELECT $1,source_message_id,0,'text','Convert amounts' FROM ${f.s}.tf_conversation_turns WHERE id=$2`,
    [f.chat, f.turn],
  );
  await f.db.platform.query(`UPDATE ${f.s}.tf_conversations SET next_message_sequence=2 WHERE id=$1`, [f.chat]);
  const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
    const response = await executeTool('tables.propose', false, context =>
      createChatTools(context.runtime).invokeWithSources(context, call),
    );
    assert.deepEqual(response.result, validation);
    assert.deepEqual(response.sources, result.sources);
    return { text: `Correct record ${records[0].recordId} before proposing again.`, sources: response.sources };
  });
  const fence = await executor.claim({ workspaceId: f.w.id, conversationId: f.chat, turnId: f.turn, generation: 0 });
  assert.ok(fence);
  assert.equal(await executor.complete(fence), 'completed');
  assert.deepEqual(
    (await f.db.platform.query(`SELECT tool,status FROM ${f.s}.tf_conversation_tool_calls WHERE turn_id=$1`, [f.turn]))
      .rows,
    [{ tool: 'tables.propose', status: 'completed' }],
  );
  assert.deepEqual(await authoring(), originalAuthoring);
  await assert.rejects(
    tools.invokeWithSources({ ...context, origin: { ...origin, conversationId: randomUUID() } }, call),
    AccessDenied,
  );
  await f.db.platform.query(`UPDATE ${f.s}.tf_memberships SET role='member' WHERE id=$1`, [f.actor.membershipId]);
  await assert.rejects(tools.invokeWithSources(context, call), AccessDenied);
  await f.db.platform.query(`UPDATE ${f.s}.tf_memberships SET role='admin' WHERE id=$1`, [f.actor.membershipId]);
  const shortened = {
    ...plan,
    target: {
      ...f.definition,
      fields: f.definition.fields.map(field => (field.id === f.title ? { ...field, maxLength: 1 } : field)),
    },
    transforms: { outputs: [] },
  };
  await assert.rejects(f.propose(shortened), error => {
    assert.deepEqual(error.validation.records[0], { ...records[0], code: 'invalid-output' });
    return true;
  });
  await f.db.platform.query(`UPDATE ${f.s}."${f.generation.physical_table}" SET ${column(f.title)}='12.5'`);
  const corrected = await tools.invokeWithSources({ ...context, callId: randomUUID() }, call);
  assert.equal(corrected.result.status, 'pending');
  const reviewed = await f.proposals.read(f.w.id, f.actor.userId, f.chat, corrected.result.id);
  assert.equal(reviewed.manifest.plans[0].effectCount, count);
  assert.equal(
    (await f.proposals.effects(f.w.id, f.actor.userId, f.chat, corrected.result.id, f.definition.id, { limit: 1 }))
      .items[0].effect.after[f.title].value,
    '12.5',
  );
  assert.deepEqual(await catalog(), originalCatalog);
  assert.deepEqual(await authoring(), { ...originalAuthoring, proposals: 1, effects: count });
});

test('chat capture wrapper retains no-effect import matches and missing capture fails closed', async t => {
  const f = await setup(t);
  const row = await f.create({ [f.key]: text('key'), [f.title]: text('same') });
  const resultId = randomUUID(),
    digest = 'b'.repeat(64);
  await f.db.platform.query(
    `INSERT INTO ${f.s}.tf_conversation_tool_calls(id,conversation_id,turn_id,tool,status,sequence) VALUES($1,$2,$3,'google.read','completed',1)`,
    [resultId, f.chat, f.turn],
  );
  const options = {
    ...tableProposalOptions(f.runtime),
    imports: {
      readSnapshot: async () => ({
        contentDigest: digest,
        sources: [{ kind: 'private-conversation', conversationId: f.chat }],
        rows: [{ key: text('key'), title: text('same') }],
      }),
    },
  };
  const proposals = createTableProposals(options);
  const plan = {
    kind: 'import',
    tableId: f.definition.id,
    expectedRevision: f.revision,
    dependsOn: [],
    reference: { kind: 'integration', resultId, contentDigest: digest },
    matchFieldIds: [f.key],
    mappings: [
      { sourceColumn: 'key', fieldId: f.key },
      { sourceColumn: 'title', fieldId: f.title },
    ],
  };
  const proposal = await f.propose(plan, proposals);
  assert.equal(
    (await f.db.platform.query(`SELECT 1 FROM ${f.s}.tf_table_proposal_capture WHERE proposal_id=$1`, [proposal.id]))
      .rowCount,
    1,
  );
  assert.deepEqual(
    (
      await f.db.platform.query(`SELECT row_id FROM ${f.s}.tf_table_proposal_matches WHERE proposal_id=$1`, [
        proposal.id,
      ])
    ).rows,
    [{ row_id: row.id }],
  );
  await f.approve(proposal);
  await f.update(row.id, { [f.title]: text('same') });
  await assert.rejects(f.capture(proposal), /proposal-stale/);
  const broken = createTableProposals({
    ...options,
    data: {
      ...generationProposalData,
      lock: async (...args) => {
        await generationProposalData.lock(...args);
      },
    },
  });
  await assert.rejects(f.propose(plan, broken), /proposal-storage-unavailable/);
  const missing = await f.propose(plan, proposals);
  await f.db.platform.query(`DELETE FROM ${f.s}.tf_table_proposal_capture WHERE proposal_id=$1`, [missing.id]);
  assert.equal((await f.proposals.read(f.w.id, f.actor.userId, f.chat, missing.id)).freshness, 'stale');
  await assert.rejects(f.approve(missing), /proposal-stale/);
});
