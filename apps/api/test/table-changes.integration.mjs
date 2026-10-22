import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool } from 'pg';
import { fixture, connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createChatTableProposals, tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { createAuth } from '../src/auth.ts';
import { registerTableChanges } from '../src/table-changes.ts';
import { registerStorageComposition } from '../src/storage-composition.ts';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools } from '@tulipfarm/agents/tools';
import { registerConversations } from '../src/conversations.ts';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';

test('table change HTTP uses real sessions, requester ownership, origin enforcement and confirmation credentials', async t => {
  const db = await fixture();
  let app, runtime, pool;
  t.after(async () => {
    await app?.close();
    await runtime?.close();
    await pool?.end();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
  app = Fastify();
  let link;
  const auth = createAuth(
    pool,
    async data => {
      link = data.url;
    },
    async () => {},
  );
  async function login() {
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: 'http://localhost:5173' }),
      body: { email: `${randomUUID()}@example.com`, name: 'Requester' },
    });
    const result = await auth.handler(new Request(link));
    const cookie = result.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return { cookie, userId: session.user.id };
  }
  const owner = await login(),
    other = await login();
  const workspace = await db.create(await workspaceTableMigrations(), { userId: owner.userId });
  runtime = createWorkspaceRuntime({
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const s = `"${workspace.names.schema}"`,
    chat = randomUUID(),
    turn = randomUUID(),
    message = randomUUID(),
    team = randomUUID(),
    table = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
    randomUUID(),
    other.userId,
  ]);
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    chat,
    owner.userId,
    workspace.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, chat, workspace.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  const proposal = await createChatTableProposals(runtime).propose(
    workspace.id,
    { kind: 'human', userId: owner.userId, membershipId: workspace.membershipId },
    randomUUID(),
    { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
    {
      plans: [
        {
          kind: 'schema',
          tableId: table,
          expectedRevision: null,
          dependsOn: [],
          target: { formatVersion: 2, id: table, owningTeamId: team, label: 'Tickets', fields: [], uniqueKeys: [] },
          transforms: { outputs: [] },
        },
      ],
    },
  );
  let credentialReads = 0;
  await app.register(swagger, { openapi: { info: { title: 'Table proposals', version: '1' } } });
  await app.register(
    async routes =>
      registerTableChanges(routes, {
        ...tableProposalOptions(runtime),
        auth,
        resolveConfirmationCredential: async () => {
          credentialReads++;
          return db.login(workspace, 'confirmation');
        },
      }),
    { prefix: '/v1' },
  );
  const conversations = createConversations(runtime);
  await app.register(async routes => registerConversations(routes, { auth, service: conversations }), {
    prefix: '/v1',
  });
  await app.ready();
  const base = `/v1/workspaces/${workspace.id}/conversations/${chat}/table-changes`;
  const url = `${base}/${proposal.id}`,
    headers = { cookie: owner.cookie, origin: 'http://localhost:5173' };
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { ...headers, cookie: other.cookie } })).statusCode, 404);
  const read = await app.inject({ url, headers });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().manifest.plans[0].after.label, 'Tickets');
  assert.equal(read.json().status, 'pending');
  assert.equal((await app.inject({ url: base, headers })).json().items[0].id, proposal.id);
  const effects = await app.inject({ url: `${url}/tables/${table}/effects?limit=1`, headers });
  assert.equal(effects.statusCode, 200, effects.body);
  assert.deepEqual(effects.json(), { digest: proposal.digest, total: 0, items: [], nextCursor: null });
  const payload = { commandId: randomUUID(), digest: proposal.digest, decision: 'approve' };
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/decision`,
        headers: { ...headers, origin: 'https://untrusted.example' },
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/decision`,
        headers: { ...headers, cookie: other.cookie },
        payload,
      })
    ).statusCode,
    404,
  );
  assert.equal(credentialReads, 0);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/decision`,
        headers,
        payload: { ...payload, digest: '0'.repeat(64) },
      })
    ).statusCode,
    409,
  );
  const decision = await app.inject({ method: 'PUT', url: `${url}/decision`, headers, payload });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().status, 'approved');
  assert.equal(credentialReads, 1);
  assert.equal(
    (await app.inject({ method: 'PUT', url: `${url}/decision`, headers, payload })).json().status,
    'approved',
  );
  assert.equal(credentialReads, 1);
  const cancel = await app.inject({
    method: 'PUT',
    url: `${url}/control`,
    headers,
    payload: { commandId: randomUUID(), digest: proposal.digest, operation: 'cancel' },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().status, 'cancelled');
  assert.equal((await app.inject({ url: `${url}/status`, headers })).json().status, 'cancelled');
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}/rows/{rowId}/history']);
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}/requests/{requestId}']);
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}/deleted-rows']);
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}/schema-history']);
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}']);
  for (const url of [
    '/v1/workspaces/:workspaceId/tables/:tableId',
    '/v1/workspaces/:workspaceId/tables/:tableId/rows',
    '/v1/workspaces/:workspaceId/tables/:tableId/rows/page',
  ])
    assert.ok(app.hasRoute({ method: 'GET', url }), url);
  for (const path of Object.values(app.swagger().paths))
    for (const route of Object.values(path)) assert.ok(route.responses['200'] || route.responses['202']);
  await db.platform.query(
    `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '33 days',expires_at=now()-interval '32 days' WHERE id=$1`,
    [proposal.id],
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_proposal_controls SET created_at=now()-interval '32 days' WHERE proposal_id=$1`,
    [proposal.id],
  );
  await db.platform.query(
    `UPDATE ${s}.tf_table_proposal_decisions SET created_at=now()-interval '32 days' WHERE proposal_id=$1`,
    [proposal.id],
  );
  const cleanup = createTableCleanup({ resolveMigrationCredential: async () => db.login(workspace, 'migration') });
  for (let i = 0; i < 20; i++) {
    if ((await cleanup(workspace.id)) === 'completed') break;
    assert.ok(i < 19);
  }
  const redacted = await app.inject({ url, headers });
  assert.equal(redacted.statusCode, 200, redacted.body);
  assert.equal(redacted.json().content, 'redacted');
  assert.equal(redacted.json().manifest.originalDigest, proposal.digest);
  assert.equal(redacted.json().status, 'cancelled');
  assert.equal((await app.inject({ url: `${url}/outcome`, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: `${url}/status`, headers })).json().digest, proposal.digest);
  assert.equal((await app.inject({ url: base, headers })).json().items[0].id, proposal.id);
  for (const action of ['decision', 'control']) {
    const response = await app.inject({
      method: 'PUT',
      url: `${url}/${action}`,
      headers,
      payload: {
        commandId: randomUUID(),
        digest: proposal.digest,
        ...(action === 'decision' ? { decision: 'approve' } : { operation: 'resume' }),
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'proposal-redacted');
  }
  const invalidTable = randomUUID(),
    fieldId = randomUUID(),
    recordId = randomUUID(),
    revision = 'a'.repeat(40);
  const definition = {
    formatVersion: 2,
    id: invalidTable,
    owningTeamId: team,
    label: 'Amounts',
    fields: [{ id: fieldId, kind: 'text', label: 'Amount', required: false, maxLength: 1000 }],
    uniqueKeys: [],
  };
  const migration = await connect(db.login(workspace, 'migration'));
  let generation;
  try {
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
      const tx = { client, schema: workspace.names.schema };
      generation = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
  } finally {
    await migration.end();
  }
  await db.platform.query(
    `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3 WHERE id=$1`,
    [invalidTable, revision, definition],
  );
  const recordBase = `/v1/workspaces/${workspace.id}/tables/${invalidTable}`;
  assert.deepEqual(
    (await app.inject({ url: recordBase, headers })).json().rowPermissions,
    { create: true, update: true, delete: true },
    'Admins may change every row',
  );
  const reader = await login(),
    readerMembership = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
    readerMembership,
    reader.userId,
  ]);
  const readerHeaders = { ...headers, cookie: reader.cookie };
  assert.equal(
    (await app.inject({ url: recordBase, headers: readerHeaders })).statusCode,
    404,
    'No read grant conceals the table',
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
    [readerMembership, invalidTable],
  );
  assert.deepEqual(
    (await app.inject({ url: recordBase, headers: readerHeaders })).json().rowPermissions,
    { create: false, update: false, delete: false },
    'Read-only members see no row write permissions',
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.row.delete')`,
    [readerMembership, invalidTable],
  );
  assert.deepEqual(
    (await app.inject({ url: recordBase, headers: readerHeaders })).json().rowPermissions,
    { create: false, update: false, delete: true },
    'Each row permission is reported independently',
  );
  const recordRequest = {
    requestId: randomUUID(),
    kind: 'create',
    tableId: invalidTable,
    revision,
    recordId: randomUUID(),
    values: { [fieldId]: { kind: 'text', value: 'receipt-only-value' } },
  };
  const recordWrite = await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload: recordRequest });
  assert.equal(recordWrite.statusCode, 200, recordWrite.body);
  assert.equal(recordWrite.json().kind, 'available');
  const rowIds = async query => {
    const response = await app.inject({ url: `${recordBase}/rows?revision=${revision}&${query}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().map(row => row.id);
  };
  const pageOf = async (query, table = recordBase, tableRevision = revision) => {
    const response = await app.inject({ url: `${table}/rows/page?revision=${tableRevision}&${query}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return {
      ids: response.json().records.map(row => row.id),
      total: response.json().total,
      nextCursor: response.json().nextCursor,
    };
  };
  const pageError = async (query, table = recordBase, tableRevision = revision) => {
    const response = await app.inject({ url: `${table}/rows/page?revision=${tableRevision}&${query}`, headers });
    return [response.statusCode, response.json().error];
  };
  const otherRecordId = randomUUID();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `${recordBase}/rows`,
        headers,
        payload: {
          ...recordRequest,
          requestId: randomUUID(),
          recordId: otherRecordId,
          values: { [fieldId]: { kind: 'text', value: 'Another value' } },
        },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    await pageOf('search=RECEIPT-only'),
    { ids: [recordRequest.recordId], total: '1', nextCursor: null },
    'Search matches text fields without case',
  );
  for (const miss of ['search=%25', 'search=_', 'search=missing'])
    assert.deepEqual(await pageOf(miss), { ids: [], total: '0', nextCursor: null }, miss);
  const sorted = await pageOf(`sort=${fieldId}&direction=desc&limit=1`);
  assert.deepEqual([sorted.ids, sorted.total], [[recordRequest.recordId], '2'], 'Sort orders by the field');
  assert.deepEqual(
    await pageOf(`sort=${fieldId}&direction=desc&limit=1&after=${sorted.nextCursor}`),
    { ids: [otherRecordId], total: null, nextCursor: null },
    'The sort cursor continues the order',
  );
  assert.deepEqual(
    await pageOf(`sort=${fieldId}`),
    { ids: [otherRecordId, recordRequest.recordId], total: '2', nextCursor: null },
    'Sort defaults to ascending',
  );
  assert.deepEqual(
    await pageOf(`filters=${encodeURIComponent(JSON.stringify([{ fieldId, op: 'eq', value: 'Another value' }]))}`),
    { ids: [otherRecordId], total: '1', nextCursor: null },
    'Filters narrow the page',
  );
  assert.deepEqual(
    await pageError(`sort=${fieldId}&after=${sorted.nextCursor}`),
    [400, 'invalid-table-values'],
    'A cursor only continues its own sort',
  );
  for (const filters of ['not-json', JSON.stringify([{ fieldId, op: 'like', value: 'x' }])])
    assert.deepEqual(await pageError(`filters=${encodeURIComponent(filters)}`), [400, 'invalid-request'], filters);
  await db.platform.query(`DELETE FROM ${s}."${generation.physical_table}" WHERE id=$1`, [otherRecordId]);
  assert.deepEqual(
    await rowIds(`ids=${recordRequest.recordId.toUpperCase()},${randomUUID()}`),
    [recordRequest.recordId],
    'Ids return only existing rows',
  );
  const invalidIds = await app.inject({ url: `${recordBase}/rows?revision=${revision}&ids=not-a-row`, headers });
  assert.equal(invalidIds.statusCode, 400, invalidIds.body);
  await db.platform.query(
    `UPDATE ${s}.tf_table_row_requests SET created_at=now()-interval '31 days' WHERE request_id=$1`,
    [recordRequest.requestId],
  );
  const expiredResult = { kind: 'expired', id: recordWrite.json().id, token: recordWrite.json().token };
  assert.deepEqual((await app.inject({ url: `${recordBase}/requests/${recordRequest.requestId}`, headers })).json(), {
    status: 'applied',
    result: expiredResult,
  });
  assert.deepEqual(
    (await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload: recordRequest })).json(),
    expiredResult,
  );
  for (const [path, method] of [
    ['/v1/workspaces/{workspaceId}/tables/{tableId}/rows', 'post'],
    ['/v1/workspaces/{workspaceId}/tables/{tableId}/requests/{requestId}', 'get'],
  ]) {
    const contract = JSON.stringify(app.swagger().paths[path][method].responses['200']);
    assert.ok(contract.includes('available') && contract.includes('expired'), contract);
  }
  const validationTable = randomUUID(),
    multiField = randomUUID(),
    numericField = randomUUID(),
    option = randomUUID(),
    validationRevision = 'c'.repeat(40),
    validationRecordId = randomUUID();
  const validationDefinition = {
    formatVersion: 2,
    id: validationTable,
    owningTeamId: team,
    label: 'Validation probes',
    fields: [
      {
        id: multiField,
        kind: 'multi-select',
        label: 'Selections',
        required: true,
        options: [{ id: option, label: 'One', retired: false }],
      },
      { id: numericField, kind: 'numeric', label: 'Amount', required: false, precision: 3, scale: 0 },
    ],
    uniqueKeys: [],
  };
  const validationMigration = await connect(db.login(workspace, 'migration'));
  try {
    await inTransaction(validationMigration, async client => {
      await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
      const tx = { client, schema: workspace.names.schema };
      const validationGeneration = await createGeneration(tx, {
        definition: validationDefinition,
        revision: validationRevision,
      });
      await activateGeneration(tx, { generationId: validationGeneration.id, expectedActiveGenerationId: null });
    });
  } finally {
    await validationMigration.end();
  }
  await db.platform.query(
    `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3 WHERE id=$1`,
    [validationTable, validationRevision, validationDefinition],
  );
  const validationBase = `/v1/workspaces/${workspace.id}/tables/${validationTable}`;
  const createdValidationRecord = await app.inject({
    method: 'POST',
    url: `${validationBase}/rows`,
    headers,
    payload: {
      requestId: randomUUID(),
      kind: 'create',
      tableId: validationTable,
      revision: validationRevision,
      recordId: validationRecordId,
      values: {
        [multiField]: { kind: 'multi-select', optionIds: [option] },
        [numericField]: { kind: 'numeric', value: '999' },
      },
    },
  });
  assert.equal(createdValidationRecord.statusCode, 200, createdValidationRecord.body);
  for (const invalid of [
    { requestId: randomUUID(), values: { [multiField]: { kind: 'multi-select', optionIds: [] } } },
    { requestId: randomUUID(), values: { [numericField]: { kind: 'numeric', value: '1000' } } },
  ]) {
    const rejected = await app.inject({
      method: 'POST',
      url: `${validationBase}/rows`,
      headers,
      payload: {
        kind: 'update',
        tableId: validationTable,
        revision: validationRevision,
        recordId: validationRecordId,
        expectedToken: createdValidationRecord.json().token,
        ...invalid,
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error, 'invalid-table-values');
    assert.deepEqual((await app.inject({ url: `${validationBase}/requests/${invalid.requestId}`, headers })).json(), {
      status: 'unknown',
    });
  }
  const validationRecords = await app.inject({ url: `${validationBase}/rows?revision=${validationRevision}`, headers });
  assert.equal(validationRecords.statusCode, 200, validationRecords.body);
  assert.deepEqual(validationRecords.json()[0].values, {
    [multiField]: { kind: 'multi-select', optionIds: [option] },
    [numericField]: { kind: 'numeric', value: '999' },
  });
  assert.deepEqual(
    await pageOf('search=999', validationBase, validationRevision),
    { ids: [], total: '0', nextCursor: null },
    'A table without text fields matches no search',
  );
  assert.deepEqual(
    await pageError(
      `filters=${encodeURIComponent(JSON.stringify([{ fieldId: numericField, op: 'gt', value: '1000' }]))}`,
      validationBase,
      validationRevision,
    ),
    [400, 'invalid-table-values'],
    'A filter value outside the field rejects',
  );
  assert.deepEqual(
    await pageError(`sort=${multiField}`, validationBase, validationRevision),
    [400, 'invalid-table-values'],
    'A multi-select field is unsortable',
  );
  const tableIds = async query =>
    (await app.inject({ url: `/v1/workspaces/${workspace.id}/tables?${query}`, headers }))
      .json()
      .tables.map(table => table.id);
  assert.deepEqual(await tableIds('search=VALIDATION'), [validationTable], 'Table search matches labels without case');
  assert.deepEqual(await tableIds('search=%25'), [], 'Table search treats % literally');
  await db.platform.query(`DELETE FROM ${s}."${generation.physical_table}" WHERE id=$1`, [recordRequest.recordId]);
  await db.platform.query(
    `INSERT INTO ${s}."${generation.physical_table}"(id,token,"f_${fieldId.replaceAll('-', '')}") VALUES($1,$1,'private-invalid-number')`,
    [recordId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) VALUES($1,$2::uuid,$2::uuid,$2::uuid,jsonb_build_object($3::text,$2::uuid::text),true)`,
    [invalidTable, recordId, fieldId],
  );
  const invalidId = randomUUID();
  const invalidPayload = {
    turnId: turn,
    input: {
      plans: [
        {
          kind: 'schema',
          tableId: invalidTable,
          expectedRevision: revision,
          dependsOn: [],
          target: {
            ...definition,
            fields: [{ id: fieldId, kind: 'numeric', label: 'Amount', required: false, precision: 30, scale: 10 }],
          },
          transforms: {
            outputs: [
              {
                fieldId,
                expression: {
                  op: 'convert',
                  input: { op: 'field', fieldId },
                  to: 'numeric',
                  timezone: 'UTC',
                  onError: 'error',
                },
              },
            ],
          },
        },
      ],
    },
  };
  const blocked = await app.inject({ method: 'PUT', url: `${base}/${invalidId}`, headers, payload: invalidPayload });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().status, 'blocked');
  assert.equal(blocked.json().total, 1);
  assert.equal(blocked.json().truncated, false);
  assert.deepEqual(blocked.json().records, [{ recordId, fieldId, code: 'conversion-failed' }]);
  assert.match(blocked.json().instruction, /ask how to correct/);
  assert.equal(blocked.body.includes('private-invalid-number'), false);
  assert.equal((await db.platform.query(`SELECT 1 FROM ${s}.tf_table_proposals WHERE id=$1`, [invalidId])).rowCount, 0);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/${invalidId}`,
        headers: { ...headers, cookie: other.cookie },
        payload: invalidPayload,
      })
    ).statusCode,
    404,
  );
  const reportUrl = `${base}/${invalidId}/outcome`;
  assert.deepEqual((await app.inject({ url: reportUrl, headers })).json(), { kind: 'blocked', report: blocked.json() });
  assert.equal((await app.inject({ url: reportUrl, headers: { ...headers, cookie: other.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ url: reportUrl.replace(chat, randomUUID()), headers })).statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/${invalidId}/decision`,
        headers,
        payload: { commandId: randomUUID(), digest: 'a'.repeat(64), decision: 'approve' },
      })
    ).statusCode,
    404,
  );
  assert.equal(credentialReads, 2);
  const restricted = await connect(db.login(workspace));
  try {
    await assert.rejects(
      restricted.query(`UPDATE ${s}.tf_table_blocked_reports SET report='{}' WHERE id=$1`, [invalidId]),
      error => error.code === '42501',
    );
    await assert.rejects(
      restricted.query(`DELETE FROM ${s}.tf_table_blocked_reports WHERE id=$1`, [invalidId]),
      error => error.code === '42501',
    );
  } finally {
    await restricted.end();
  }
  await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [workspace.membershipId]);
  assert.equal((await app.inject({ url: reportUrl, headers })).statusCode, 404);
  await db.platform.query(`UPDATE ${s}.tf_memberships SET role='admin' WHERE id=$1`, [workspace.membershipId]);
  await db.platform.query(`UPDATE ${s}.tf_table_catalog SET applied_revision=$2 WHERE id=$1`, [
    invalidTable,
    'b'.repeat(40),
  ]);
  assert.equal((await app.inject({ url: reportUrl, headers })).statusCode, 404);
  await db.platform.query(`UPDATE ${s}.tf_table_catalog SET applied_revision=$2 WHERE id=$1`, [invalidTable, revision]);
  await db.platform.query(
    `UPDATE ${s}."${generation.physical_table}" SET "f_${fieldId.replaceAll('-', '')}"='42' WHERE id=$1`,
    [recordId],
  );
  const replay = await app.inject({ method: 'PUT', url: `${base}/${invalidId}`, headers, payload: invalidPayload });
  assert.deepEqual(
    replay.json(),
    blocked.json(),
    'Reusing the same tool identity returns its original immutable report after correction',
  );
  const changedInput = structuredClone(invalidPayload);
  changedInput.input.plans[0].target.label = 'Changed input';
  assert.equal(
    (await app.inject({ method: 'PUT', url: `${base}/${invalidId}`, headers, payload: changedInput })).statusCode,
    409,
  );
  const correctedId = randomUUID();
  const corrected = await app.inject({
    method: 'PUT',
    url: `${base}/${correctedId}`,
    headers,
    payload: invalidPayload,
  });
  assert.equal(corrected.statusCode, 202, corrected.body);
  assert.equal(corrected.json().id, correctedId);
  assert.deepEqual((await app.inject({ url: `${base}/${correctedId}/outcome`, headers })).json(), { kind: 'proposal' });
  assert.deepEqual(
    (
      await db.platform.query(`SELECT applied_revision,applied_definition FROM ${s}.tf_table_catalog WHERE id=$1`, [
        invalidTable,
      ])
    ).rows[0],
    { applied_revision: revision, applied_definition: definition },
  );
  await db.platform.query(
    `UPDATE ${s}."${generation.physical_table}" SET "f_${fieldId.replaceAll('-', '')}"='private-invalid-number' WHERE id=$1`,
    [recordId],
  );
  const extraIds = Array.from({ length: 100 }, () => randomUUID());
  await db.platform.query(
    `INSERT INTO ${s}."${generation.physical_table}"(id,token,"f_${fieldId.replaceAll('-', '')}") SELECT id,id,'private-invalid-number' FROM unnest($1::uuid[]) AS id`,
    [extraIds],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) SELECT $1,id,id,id,jsonb_build_object($3::text,id::text),true FROM unnest($2::uuid[]) AS id`,
    [invalidTable, extraIds, fieldId],
  );
  const boundedId = randomUUID();
  const bounded = await app.inject({ method: 'PUT', url: `${base}/${boundedId}`, headers, payload: invalidPayload });
  assert.equal(bounded.statusCode, 409, bounded.body);
  assert.equal(bounded.json().status, 'blocked', bounded.body);
  assert.equal(bounded.json().records.length, 100);
  assert.equal(bounded.json().total, 101);
  assert.equal(bounded.json().truncated, true);
  assert.equal(bounded.body.includes('private-invalid-number'), false);
  assert.deepEqual((await app.inject({ url: `${base}/${boundedId}/outcome`, headers })).json().report, bounded.json());
  await db.platform.query(`DELETE FROM ${s}."${generation.physical_table}" WHERE id=ANY($1::uuid[])`, [extraIds]);
  await db.platform.query(`DELETE FROM ${s}.tf_table_identities WHERE table_id=$1 AND row_id=ANY($2::uuid[])`, [
    invalidTable,
    extraIds,
  ]);
  const reportChat = randomUUID();
  await conversations.create(workspace.id, owner.userId, { commandId: randomUUID(), chatId: reportChat });
  const otherTurn = await conversations.send(workspace.id, owner.userId, reportChat, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Identity isolation probe' }],
  });
  const collision = await app.inject({
    method: 'PUT',
    url: `/v1/workspaces/${workspace.id}/conversations/${reportChat}/table-changes/${invalidId}`,
    headers,
    payload: { ...invalidPayload, turnId: otherTurn.turnId },
  });
  assert.equal(
    collision.statusCode,
    404,
    'A blocked report identity cannot become an executable proposal in a different conversation',
  );
  await conversations.cancel(workspace.id, owner.userId, reportChat, otherTurn.turnId, {
    commandId: randomUUID(),
    expectedGeneration: 0,
  });
  const calls = [];
  const executor = createConversationExecutor(runtime, async ({ executeTool, messages }) => {
    const input = structuredClone(invalidPayload.input);
    if (messages.at(-1).text.includes('42'))
      input.plans[0].transforms.outputs[0].expression = { op: 'literal', value: { kind: 'numeric', value: '42' } };
    const result = await executeTool('tables.propose', false, context => {
      calls.push(context.callId);
      return createChatTools(context.runtime).invokeWithSources(
        {
          ...context,
          origin: {
            ...context.origin,
            sources: [...context.origin.sources, { kind: 'private-conversation', conversationId: chat }],
          },
        },
        { tool: 'tables.propose', input: JSON.stringify(input) },
      );
    });
    assert.ok(result.result, JSON.stringify(result));
    return {
      text:
        result.result.status === 'blocked'
          ? 'Please review the invalid records and tell me how to correct the conversion.'
          : 'A new proposal is ready for review.',
      sources: result.sources,
    };
  });
  const firstTurn = await conversations.send(workspace.id, owner.userId, reportChat, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Convert Amount to a number' }],
  });
  assert.equal(
    await executor.process({
      workspaceId: workspace.id,
      conversationId: reportChat,
      turnId: firstTurn.turnId,
      generation: 0,
    }),
    'completed',
  );
  const history = await conversations.history(workspace.id, owner.userId, reportChat);
  assert.ok(
    history.messages.some(message => message.tools.some(tool => tool.id === calls[0] && tool.status === 'completed')),
  );
  const toolReportUrl = `/v1/workspaces/${workspace.id}/conversations/${reportChat}/table-changes/${calls[0]}/outcome`;
  assert.deepEqual((await app.inject({ url: toolReportUrl, headers })).json().report.records, [
    { recordId, fieldId, code: 'conversion-failed' },
  ]);
  await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [chat, other.userId]);
  assert.equal(
    (await app.inject({ url: toolReportUrl, headers })).statusCode,
    404,
    'Revoked inherited source denies report retrieval',
  );
  await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [chat, owner.userId]);
  if (process.env.TABLE_BLOCKED_BROWSER === '1') {
    const { proveBlockedTableBrowser } = await import('../../web/test/table-blocked.browser.mjs');
    await proveBlockedTableBrowser({
      app,
      cookie: owner.cookie,
      userId: owner.userId,
      workspaceId: workspace.id,
      membershipId: workspace.membershipId,
      chatId: reportChat,
      recordId,
      fieldId,
      processReply: async () => {
        for (const work of await executor.due(workspace.id))
          if (work.conversationId === reportChat) assert.equal(await executor.process(work), 'completed');
      },
      deny: async denied =>
        db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [
          chat,
          denied ? other.userId : owner.userId,
        ]),
    });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0], calls[1]);
    assert.equal(
      (
        await app.inject({
          url: `/v1/workspaces/${workspace.id}/conversations/${reportChat}/table-changes/${calls[1]}`,
          headers,
        })
      ).json().status,
      'pending',
    );
    assert.deepEqual(
      (
        await db.platform.query(`SELECT applied_revision,applied_definition FROM ${s}.tf_table_catalog WHERE id=$1`, [
          invalidTable,
        ])
      ).rows[0],
      { applied_revision: revision, applied_definition: definition },
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT "f_${fieldId.replaceAll('-', '')}" AS value FROM ${s}."${generation.physical_table}" WHERE id=$1`,
          [recordId],
        )
      ).rows[0].value,
      'private-invalid-number',
    );
  }
  const env = { ...process.env };
  const composed = Fastify();
  try {
    Object.assign(process.env, {
      DATABASE_URL: db.connectionString,
      WORKSPACE_RUNTIME_KEY_ID: 'runtime-test',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      WORKSPACE_CONFIRMATION_KEY_ID: 'confirmation-test',
      WORKSPACE_CONFIRMATION_KEY: '22'.repeat(32),
      WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL: db.login(workspace, 'confirmation'),
      INTEGRATION_CREDENTIAL_KEY_ID: 'integration-test',
      INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
      EMAIL_DELIVERY_KEY_ID: 'email-test',
      EMAIL_DELIVERY_KEY: '44'.repeat(32),
      CHAT_R2_ACCOUNT_ID: 'a'.repeat(32),
      CHAT_R2_BUCKET: 'table-composition-test',
      CHAT_R2_ACCESS_KEY_ID: 'synthetic-test-id',
      CHAT_R2_SECRET_ACCESS_KEY: 'synthetic-test-secret',
    });
    await composed.register(async routes => registerStorageComposition(routes, { auth, pool }, {}, runtime), {
      prefix: '/v1',
    });
    const folder = await composed.inject({
      method: 'PUT',
      url: `/v1/workspaces/${workspace.id}/files/${randomUUID()}/folder`,
      headers,
      payload: { name: 'Default composition', parentId: null },
    });
    assert.equal(folder.statusCode, 200, folder.body);
    assert.equal(folder.json().name, 'Default composition');
    const oldSave = await composed.inject({
      method: 'PUT',
      url: `/v1/workspaces/${workspace.id}/tables/${table}`,
      headers,
      payload: {},
    });
    assert.equal(oldSave.statusCode, 404, oldSave.body);
  } finally {
    await composed.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
  await auth.api.signOut({ headers: new Headers({ cookie: owner.cookie }) });
  assert.equal((await app.inject({ url, headers })).statusCode, 401);
});
