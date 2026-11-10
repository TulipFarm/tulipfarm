import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { createTableExecution, executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { importWorkbook, importObjectFixture } from '../../tables/test/import-object-fixture.mjs';
import { createChatTools } from '../src/tools.ts';
import { AccessDenied } from '@tulipfarm/access';
import { createChatTableProposals, tableProposalOptions } from '../src/table-proposals.ts';
import { requireTableSources, requireTableImportReference } from '../src/table-sources.ts';
import { tableDefinitionMessages } from '@tulipfarm/tables/definition';
import { tableProposalRules } from '@tulipfarm/tables/proposal-contracts';
import { tableProposalJsonSchema } from '@tulipfarm/tables/proposal-json-schema';

test('chat distinguishes creation eligibility, validates proposal arguments, and enforces current authority', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const ws = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const s = `"${ws.names.schema}"`,
    team = randomUUID(),
    tableId = randomUUID();
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const conversationId = randomUUID(),
    turnId = randomUUID(),
    message = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'qa-20261003-cloud-operations')`, [team]);
  await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
    actor.membershipId,
    team,
  ]);
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    conversationId,
    actor.userId,
    actor.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, conversationId, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turnId, conversationId, message],
  );
  // Every admin belongs to the internal _admin team, which can own assets before anyone creates a team.
  const adminTeam = {
    id: (await db.platform.query(`SELECT id FROM ${s}.tf_teams WHERE name='_admin'`)).rows[0].id,
    name: '_admin',
  };
  const tools = createChatTools(runtime);
  const context = { workspaceId: ws.id, actor, callId: randomUUID(), origin: { conversationId, turnId, sources: [] } };
  const input = {
    plans: [
      {
        kind: 'schema',
        tableId,
        expectedRevision: null,
        dependsOn: [],
        target: {
          formatVersion: 2,
          id: tableId,
          owningTeamId: team,
          label: 'qa-20261003-cloud-menu-item',
          uniqueKeys: [],
          fields: [
            { id: randomUUID(), label: 'name', kind: 'text', required: true, maxLength: 10000 },
            { id: randomUUID(), label: 'priceInr', kind: 'numeric', required: true, precision: 30, scale: 10 },
            { id: randomUUID(), label: 'available', kind: 'boolean', required: true },
            { id: randomUUID(), label: 'description', kind: 'text', required: true, maxLength: 10000 },
          ],
        },
        transforms: { outputs: [] },
      },
    ],
  };
  const count = async table =>
    (await db.platform.query(`SELECT count(*)::int AS count FROM ${s}.${table}`)).rows[0].count;
  // The workspace starts with its system tables already in the catalog.
  const catalogTables = await count('tf_table_catalog');
  await t.test('eligible admin can prepare an exact review without creating data', async () => {
    const discovery = (await tools.invokeWithSources(context, { tool: 'schema.context' })).result;
    assert.equal(discovery.capabilityTableId, null);
    assert.deepEqual(discovery.creation, {
      allowed: true,
      eligibleOwningTeams: [adminTeam, { id: team, name: 'qa-20261003-cloud-operations' }].sort((a, b) =>
        a.id < b.id ? -1 : 1,
      ),
    });
    assert.equal(discovery.capabilities.manageSchema, false);
    assert.equal(discovery.tableFound, undefined);
    assert.equal(new Set(discovery.newIds).size, 32);
    for (const id of discovery.newIds)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Models often pass the id they made up for the new table; they still get the creation context.
    const madeUp = (await tools.invokeWithSources(context, { tool: 'schema.context', tableId: randomUUID() })).result;
    assert.equal(madeUp.tableFound, false);
    assert.equal(madeUp.appliedDefinition, null);
    assert.deepEqual(madeUp.creation, discovery.creation);
    assert.ok(Object.values(madeUp.capabilities).every(allowed => allowed === false));
    const output = (await tools.invokeWithSources(context, { tool: 'tables.propose', input: JSON.stringify(input) }))
      .result;
    assert.equal(output.status, 'pending');
    assert.ok(output.reviewSummary.includes(JSON.stringify(input.plans[0].target.label)));
    assert.match(output.reviewSummary, /no rows are included/);
    // A new table's review holds only its structure, so chat must not call it an import.
    assert.equal(output.rowsIncluded, false);
    assert.match(output.instruction, /holds no rows, so approving it imports nothing/);
    const review = await createChatTableProposals(runtime).read(ws.id, actor, conversationId, output.id);
    assert.equal(review.manifest.plans[0].effectCount, 0);
    assert.equal(review.content, 'available');
    assert.equal(review.status, 'pending');
    assert.deepEqual(review.manifest.plans[0].after, input.plans[0].target);
    assert.equal(await count('tf_table_proposals'), 1);
    assert.equal(await count('tf_table_catalog'), catalogTables);
  });
  await t.test('invalid JSON and incomplete definitions are argument errors, not permission denials', async () => {
    for (const input of [
      '{',
      JSON.stringify({ plans: [] }),
      JSON.stringify({
        plans: [
          {
            kind: 'schema',
            tableId,
            expectedRevision: null,
            dependsOn: [],
            target: { formatVersion: 2 },
            transforms: { outputs: [] },
          },
        ],
      }),
    ]) {
      const result = (
        await tools.invokeWithSources({ ...context, callId: randomUUID() }, { tool: 'tables.propose', input })
      ).result;
      assert.equal(result.error, 'invalid-arguments');
      assert.match(result.instruction, /not a permission denial/);
    }
    // A made-up id for a new field is replaced with a fresh UUID, so the proposal is created.
    const newTable = randomUUID();
    const madeUp = structuredClone(input);
    madeUp.plans[0].tableId = newTable;
    madeUp.plans[0].target.id = newTable;
    madeUp.plans[0].target.fields[0].id = 'vendor-name-field';
    madeUp.plans[0].target.uniqueKeys = [{ id: 'by-vendor', fieldIds: ['vendor-name-field'], nulls: 'distinct' }];
    const repaired = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: JSON.stringify(madeUp) },
      )
    ).result;
    assert.equal(repaired.status, 'pending');
    const saved = (await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [repaired.id]))
      .rows[0].manifest.plans[0].after;
    assert.match(saved.fields[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(saved.uniqueKeys[0].fieldIds, [saved.fields[0].id]);
    await db.platform.query(`DELETE FROM ${s}.tf_table_proposal_capture WHERE proposal_id=$1`, [repaired.id]);
    await db.platform.query(`DELETE FROM ${s}.tf_table_proposals WHERE id=$1`, [repaired.id]);
    // A reference to an id that no field has cannot be repaired; the error offers fresh UUIDs.
    const malformed = structuredClone(input);
    malformed.plans[0].target.uniqueKeys = [{ id: randomUUID(), fieldIds: ['vendor-name-field'], nulls: 'distinct' }];
    const result = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: JSON.stringify(malformed) },
      )
    ).result;
    assert.equal(result.error, 'invalid-arguments');
    assert.equal(result.newIds.length, 32);
    assert.match(result.idInstruction, /newIds/);
    assert.equal(await count('tf_table_proposals'), 1);
  });
  await t.test('rule failures explain which rule was broken', async () => {
    const proposals = await count('tf_table_proposals');
    const [plan] = input.plans;
    const [first, numeric] = plan.target.fields;
    const invalid = {
      plans: [
        {
          ...plan,
          target: { ...plan.target, fields: [first, first, { ...numeric, id: randomUUID(), precision: 3, scale: 5 }] },
        },
      ],
    };
    const result = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: JSON.stringify(invalid) },
      )
    ).result;
    assert.equal(result.error, 'invalid-arguments');
    assert.match(result.instruction, /not a permission denial/);
    assert.deepEqual(result.issues, [
      {
        path: ['plans', 0, 'target', 'fields', 2],
        code: 'custom',
        message: tableDefinitionMessages.decimalPrecisionScale,
      },
      { path: ['plans', 0, 'target', 'fields'], code: 'custom', message: tableDefinitionMessages.duplicateField },
    ]);
    const echoed = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: JSON.stringify({ plans: [{ ...plan, ['k'.repeat(5000)]: true }] }) },
      )
    ).result;
    assert.equal(echoed.issues[0].code, 'unrecognized_keys');
    assert.equal(echoed.issues[0].message.length, 200);
    const malformed = (
      await tools.invokeWithSources({ ...context, callId: randomUUID() }, { tool: 'tables.propose', input: '{' })
    ).result;
    assert.deepEqual(
      malformed.issues.map(({ code }) => code),
      ['invalid-json'],
    );
    const skill = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'skills.read', skillId: 'table-authoring' },
      )
    ).result;
    for (const { rule, message } of tableProposalRules) {
      assert.ok(skill.constraints.includes(rule), rule);
      assert.ok(skill.constraints.includes(message), message);
    }
    assert.match(skill.constraints, /Call tables\.propose with input set to the plans as one JSON-encoded string\./);
    assert.deepEqual(skill.proposalInputSchema, tableProposalJsonSchema());
    assert.equal(await count('tf_table_proposals'), proposals);
  });
  await t.test('an admin sees creatable teams they do not belong to only as opaque ids', async () => {
    const hidden = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Private payroll')`, [hidden]);
    try {
      const discovery = (
        await tools.invokeWithSources({ ...context, callId: randomUUID() }, { tool: 'schema.context' })
      ).result;
      assert.deepEqual(
        [...discovery.creation.eligibleOwningTeams].sort((a, b) => a.id.localeCompare(b.id)),
        [adminTeam, { id: team, name: 'qa-20261003-cloud-operations' }, { id: hidden, name: null }].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      );
    } finally {
      await db.platform.query(`DELETE FROM ${s}.tf_teams WHERE id=$1`, [hidden]);
    }
  });
  await t.test('team membership alone does not authorize creation', async () => {
    await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [actor.membershipId]);
    const discovery = (await tools.invokeWithSources(context, { tool: 'schema.context' })).result;
    assert.deepEqual(discovery.creation, { allowed: false, eligibleOwningTeams: [] });
    await assert.rejects(
      tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: JSON.stringify(input) },
      ),
      AccessDenied,
    );
    assert.equal(await count('tf_table_proposals'), 1);
    assert.equal(await count('tf_table_catalog'), catalogTables);
  });
  await t.test('chat cites the requester’s own memory, but never another member’s', async () => {
    await db.platform.query(`UPDATE ${s}.tf_memberships SET role='admin' WHERE id=$1`, [actor.membershipId]);
    const other = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,'other-member','member')`, [
      other,
    ]);
    const newTable = randomUUID();
    const plans = JSON.stringify({
      plans: [{ ...input.plans[0], tableId: newTable, target: { ...input.plans[0].target, id: newTable } }],
    });
    // Chat adds the requester's personal memory to every call's sources.
    const memory = membershipId => ({
      ...context,
      callId: randomUUID(),
      origin: { ...context.origin, sources: [{ kind: 'personal-memory', membershipId }] },
    });
    await assert.rejects(
      tools.invokeWithSources(memory(other), { tool: 'tables.propose', input: plans }),
      AccessDenied,
    );
    assert.equal(await count('tf_table_proposals'), 1);
    const output = (await tools.invokeWithSources(memory(actor.membershipId), { tool: 'tables.propose', input: plans }))
      .result;
    assert.equal(output.status, 'pending');
    assert.equal(await count('tf_table_proposals'), 2);
  });
  await t.test('a schema change to a table listed earlier in the chat does not deny later imports', async () => {
    const listed = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_table_catalog(id,owning_team_id,physical_table,display_name,target_revision,applied_revision) VALUES($1,$2,'listed_earlier','Listed','r2','r2')`,
      [listed, team],
    );
    // Earlier turns listed and read the table at revision r1; it has since been migrated to r2.
    const stale = sources => ({ ...context, callId: randomUUID(), origin: { ...context.origin, sources } });
    const earlier = [
      { kind: 'table-rows', tableId: listed, revision: 'r1' },
      { kind: 'table-schema', tableId: listed, revision: 'r1' },
    ];
    assert.deepEqual((await tools.invokeWithSources(stale(earlier), { tool: 'tables.import.attachments' })).result, {
      attachments: [],
    });
    const newTable = randomUUID();
    const output = (
      await tools.invokeWithSources(stale(earlier), {
        tool: 'tables.propose',
        input: JSON.stringify({
          plans: [{ ...input.plans[0], tableId: newTable, target: { ...input.plans[0].target, id: newTable } }],
        }),
      })
    ).result;
    assert.equal(output.status, 'pending');
    const saved = (await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [output.id]))
      .rows[0].manifest.sources;
    assert.deepEqual(
      saved.filter(source => source.tableId === listed),
      [
        { kind: 'table-rows', tableId: listed, revision: 'r2' },
        { kind: 'table-schema', tableId: listed, revision: 'r2' },
      ],
    );
    // A row tool on a table that is not a typed table returns the readable tables, not an error that reads as a denial.
    const missing = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'rows.get', tableId: listed, expectedAppliedRevision: 'r2', recordId: randomUUID() },
      )
    ).result;
    assert.equal(missing.error, 'table-not-found');
    assert.match(missing.instruction, /not a permission problem/);
    assert.ok(Array.isArray(missing.tables));
    // A table that no longer exists is still a denial.
    await assert.rejects(
      tools.invokeWithSources(stale([{ kind: 'table-rows', tableId: randomUUID(), revision: 'r1' }]), {
        tool: 'tables.import.attachments',
      }),
      AccessDenied,
    );
  });
  await t.test(
    'a guessed attachment ID or digest prepares the chat’s only file, and asks with the list otherwise',
    async () => {
      const objects = new Map();
      const store = {
        putIfAbsent: async (key, bytes) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        },
        read: async (key, length) => {
          const bytes = objects.get(key);
          if (!bytes || bytes.length !== length) throw new Error('private-storage-value');
          return Buffer.from(bytes);
        },
      };
      const files = createChatTools(runtime, { objects: { attachments: store, snapshots: store } });
      const attach = async (ordinal, csv) => {
        const id = randomUUID(),
          key = randomUUID(),
          bytes = Buffer.from(csv),
          digest = createHash('sha256').update(bytes).digest('hex');
        objects.set(`${ws.id}/${key}`, bytes);
        await db.platform.query(
          `INSERT INTO ${s}.tf_conversation_attachments(id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id) VALUES($1,$2,$3,$4,'orders.csv','text/csv',$5,$6,'bound',$7)`,
          [id, conversationId, actor.membershipId, key, bytes.length, digest, message],
        );
        await db.platform.query(
          `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,attachment_id) VALUES($1,$2,$3,'attachment',$4)`,
          [conversationId, message, ordinal, id],
        );
        return { attachmentId: id, contentDigest: digest };
      };
      const only = await attach(0, 'Order ID,Customer\nRV-1,Hooli\n');
      const call = (attachmentId, contentDigest) =>
        files.invokeWithSources(
          { ...context, callId: randomUUID() },
          {
            tool: 'tables.import.file',
            attachmentId,
            contentDigest,
            selection: JSON.stringify({
              format: 'csv',
              delimiter: ',',
              header: { kind: 'row', row: 1 },
              conversions: {},
              empty: 'null',
            }),
          },
        );
      // Models see the file but not its digest, and often send the empty file's digest or a made-up ID.
      const guessed = (await call(randomUUID(), createHash('sha256').update('').digest('hex'))).result;
      assert.deepEqual(
        { kind: guessed.kind, attachmentId: guessed.attachmentId, contentDigest: guessed.contentDigest },
        { kind: 'file', ...only },
      );
      assert.deepEqual(guessed.columns, ['Order ID', 'Customer']);
      const malformed = (await call('orders.csv', 'unknown')).result;
      assert.equal(malformed.attachmentId, only.attachmentId);
      const other = await attach(1, 'Order ID\nRV-2\n');
      const ambiguous = (await call(randomUUID(), only.contentDigest)).result;
      assert.equal(ambiguous.code, 'attachment-unknown');
      assert.deepEqual(
        ambiguous.attachments.map(item => item.attachmentId).sort(),
        [only.attachmentId, other.attachmentId].sort(),
      );
      assert.match(ambiguous.instruction, /Do not ask the person to attach it again/);
      // The right ID with a guessed digest still finds its file.
      assert.equal((await call(other.attachmentId, 'f'.repeat(64))).result.attachmentId, other.attachmentId);
    },
  );
  await t.test('a proposal with stray closing brackets after its JSON is read as the JSON before them', async () => {
    const newTable = randomUUID();
    const plans = [{ ...input.plans[0], tableId: newTable, target: { ...input.plans[0].target, id: newTable } }];
    const output = (
      await tools.invokeWithSources(
        { ...context, callId: randomUUID() },
        { tool: 'tables.propose', input: `${JSON.stringify({ plans })}]}` },
      )
    ).result;
    assert.equal(output.status, 'pending');
  });
  await t.test('file import tools prepare and propose CSV and XLSX without sheet or header hints', async importTest => {
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Current Orders',
      fields: [
        { id: randomUUID(), label: 'Order ID', kind: 'text', required: true, maxLength: 100 },
        { id: randomUUID(), label: 'Total', kind: 'numeric', required: false, precision: 8, scale: 2 },
      ],
      uniqueKeys: [],
    };
    definition.uniqueKeys.push({ id: randomUUID(), fieldIds: [definition.fields[0].id], nulls: 'distinct' });
    const revision = 'b'.repeat(40);
    const other = {
      ...definition,
      id: randomUUID(),
      label: 'Historical Orders',
      fields: definition.fields.map(field => ({ ...field, id: randomUUID() })),
    };
    other.uniqueKeys = [{ ...definition.uniqueKeys[0], id: randomUUID(), fieldIds: [other.fields[0].id] }];
    const pending = { ...other, id: randomUUID(), label: 'Pending Orders' };
    const punctuated = { ...other, id: randomUUID(), label: 'Current Orders, Priority' };
    const physicalTables = new Map();
    const migration = await connect(db.login(ws, 'migration'));
    try {
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
        const tx = { client, schema: ws.names.schema };
        for (const table of [definition, other, pending, punctuated]) {
          const generation = await createGeneration(tx, { definition: table, revision });
          physicalTables.set(table.id, generation.physical_table);
          if (table === pending) continue;
          await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
          await client.query(
            `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
            [table.id, revision, table, generation.physical_table],
          );
        }
      });
    } finally {
      await migration.end();
    }
    const physicalTable = physicalTables.get(definition.id);
    await db.platform.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`, [
      team,
      definition.id,
    ]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,5,'text',$3)`,
      [conversationId, message, `Import the attached file into the existing table ${definition.label}`],
    );
    const request = name =>
      db.platform.query(`UPDATE ${s}.tf_conversation_parts SET text=$2 WHERE message_id=$1 AND kind='text'`, [
        message,
        `Import the attached file into the existing table ${name}`,
      ]);
    const objects = importObjectFixture();
    const files = createChatTools(runtime, { objects });
    await createTableService(runtime, {}, executionCompatibility).mutate(ws.id, actor, {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: randomUUID(),
      values: {
        [definition.fields[0].id]: { kind: 'text', value: 'A-1' },
        [definition.fields[1].id]: { kind: 'numeric', value: '1' },
      },
    });
    const rows = [
      ['Order ID', 'Total'],
      ['A-1', 12],
      ['A-2', 15],
      ['A-3', 18],
    ];
    const sheet = await importWorkbook([['Orders export'], [], ...rows], book =>
      book.addWorksheet('Notes').addRow(['Read me']),
    );
    for (const [ordinal, bytes, selection] of [
      [2, Buffer.from(rows.map(row => row.join(',')).join('\n')), {}],
      [3, Buffer.from(rows.map(row => row.join(';')).join('\n')), {}],
      [4, sheet, { format: 'xlsx' }],
    ]) {
      const attachmentId = randomUUID(),
        key = randomUUID(),
        contentDigest = createHash('sha256').update(bytes).digest('hex');
      await objects.attachments.putIfAbsent(`${ws.id}/${key}`, bytes);
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_attachments(id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id) VALUES($1,$2,$3,$4,'orders','application/octet-stream',$5,$6,'bound',$7)`,
        [attachmentId, conversationId, actor.membershipId, key, bytes.length, contentDigest, message],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,attachment_id) VALUES($1,$2,$3,'attachment',$4)`,
        [conversationId, message, ordinal, attachmentId],
      );
      const prepared = (
        await files.invokeWithSources(
          { ...context, callId: randomUUID() },
          {
            tool: 'tables.import.file',
            attachmentId,
            contentDigest,
            selection: JSON.stringify(selection),
          },
        )
      ).result;
      assert.equal(prepared.error, undefined, JSON.stringify(prepared));
      assert.deepEqual(prepared.columns, ['Order ID', 'Total']);
      const importPlan = table => ({
        kind: 'import',
        tableId: table.id,
        dependsOn: [],
        expectedRevision: revision,
        reference: { kind: 'file', attachmentId, contentDigest },
        matchFieldIds: table.uniqueKeys[0].fieldIds,
        mappings: table.fields.map(field => ({ sourceColumn: field.label, fieldId: field.id })),
      });
      const propose = plans =>
        files.invokeWithSources(
          { ...context, callId: randomUUID() },
          { tool: 'tables.propose', input: JSON.stringify({ plans }) },
        );
      await importTest.test(`partial destination names cannot select an existing table (${ordinal})`, async () => {
        const before = await count('tf_table_proposals');
        try {
          for (const name of ['Missing Current Orders', 'Current', 'Current Orders Extended', 'Current-Orders']) {
            await request(name);
            const wrong = (await propose([importPlan(definition)])).result;
            assert.equal(wrong.error, 'table-not-found', JSON.stringify(wrong));
          }
          assert.equal(await count('tf_table_proposals'), before);
        } finally {
          await request(definition.label);
        }
      });
      await importTest.test(`destination names end at sentence and clause boundaries (${ordinal})`, async () => {
        try {
          for (const suffix of [
            '.',
            ', please',
            ';',
            '!',
            '?',
            ':',
            ' thanks',
            '\nand then show the review',
            ' and then show the review',
          ]) {
            await request(`${definition.label}${suffix}`);
            const output = (await propose([importPlan(definition)])).result;
            assert.equal(output.status, 'pending', JSON.stringify(output));
            assert.deepEqual(output.tables, [{ id: definition.id, name: definition.label }]);
          }
          await db.platform.query(`UPDATE ${s}.tf_conversation_parts SET text=$2 WHERE message_id=$1 AND kind='text'`, [
            message,
            `${definition.label}, please`,
          ]);
          assert.equal((await propose([importPlan(definition)])).result.status, 'pending');
          await request(`${punctuated.label}, please`);
          assert.equal((await propose([importPlan(definition)])).result.error, 'table-not-found');
          const exact = (await propose([importPlan(punctuated)])).result;
          assert.equal(exact.status, 'pending', JSON.stringify(exact));
          assert.deepEqual(exact.tables, [{ id: punctuated.id, name: punctuated.label }]);
          await request(`Missing ${definition.label}, please`);
          assert.equal((await propose([importPlan(definition)])).result.error, 'table-not-found');
        } finally {
          await request(definition.label);
        }
      });
      const before = await count('tf_table_proposals');
      for (let attempt = 0; attempt < 10; attempt++) {
        const wrong = (await propose([importPlan(other)])).result;
        assert.equal(wrong.error, 'table-not-found', JSON.stringify(wrong));
        assert.equal(wrong.tables[0].id, definition.id);
        assert.equal(wrong.tables[0].name, definition.label);
      }
      const repairedWrong = (
        await propose([{ kind: 'import', tableName: other.label, reference: importPlan(other).reference }])
      ).result;
      assert.equal(repairedWrong.error, 'table-not-found', JSON.stringify(repairedWrong));
      const mixed = (await propose([importPlan(definition), importPlan(other)])).result;
      assert.equal(mixed.error, 'table-not-found', JSON.stringify(mixed));
      for (const name of ['Missing Orders', pending.label]) {
        await request(name);
        const wrong = (await propose([importPlan(other)])).result;
        assert.equal(wrong.error, 'table-not-found', JSON.stringify(wrong));
        assert.match(wrong.instruction, /no table.*exists or is ready/i);
        const loose = (await propose([{ kind: 'import', tableName: name, reference: importPlan(other).reference }]))
          .result;
        assert.equal(loose.error, 'import-table-not-found', JSON.stringify(loose));
      }
      const notApplied = (await propose([importPlan(pending)])).result;
      assert.equal(notApplied.error, 'table-not-found', JSON.stringify(notApplied));
      await request(definition.label);
      await db.platform.query(`UPDATE ${s}.tf_table_catalog SET maintenance=true WHERE id=$1`, [definition.id]);
      try {
        const unavailable = (await propose([importPlan(definition)])).result;
        assert.equal(unavailable.error, 'table-not-ready', JSON.stringify(unavailable));
      } finally {
        await db.platform.query(`UPDATE ${s}.tf_table_catalog SET maintenance=false WHERE id=$1`, [definition.id]);
      }
      assert.equal(await count('tf_table_proposals'), before);
      await request(ordinal === 2 ? '  CURRENT \t ORDERS  ' : ordinal === 3 ? `"${definition.label}"` : definition.id);
      const output = (await propose([importPlan(definition)])).result;
      assert.equal(output.status, 'pending', JSON.stringify(output));
      assert.deepEqual(output.tables, [{ id: definition.id, name: definition.label }]);
      assert.ok(output.instruction.includes(definition.label));
      assert.ok(!output.instruction.includes(other.label));
      const proposals = createChatTableProposals(runtime, objects);
      const review = await proposals.read(ws.id, actor, conversationId, output.id);
      const plan = review.manifest.plans[0];
      assert.equal(plan.input.tableId, definition.id);
      assert.equal(plan.after.label, definition.label);
      assert.equal(plan.effectCount, 3);
      assert.equal(plan.audience.administrators, true);
      assert.deepEqual(plan.audience.teams, [team]);
      assert.deepEqual(
        plan.input.mappings.map(mapping => mapping.sourceColumn),
        ['Order ID', 'Total'],
      );
      const effects = await proposals.effects(ws.id, actor, conversationId, output.id, definition.id, { limit: 10 });
      assert.deepEqual(effects.items.map(item => item.effect.kind).sort(), ['create', 'create', 'update']);
      assert.equal(effects.items[0].effect.after[definition.fields[1].id].kind, 'numeric');
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${s}."${physicalTable}"`)).rows[0].count,
        1,
      );
      if (ordinal === 4) {
        await createTableProposalDecisions({
          ...tableProposalOptions(runtime, objects),
          resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
        }).decide(ws.id, actor, conversationId, output.id, {
          digest: output.digest,
          commandId: randomUUID(),
          decision: 'approve',
        });
        await importTest.test('a post-approval import follow-up keeps the approved destination', async () => {
          const nextMessage = randomUUID(),
            nextTurn = randomUUID();
          await db.platform.query(
            `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,2,'human',$3)`,
            [nextMessage, conversationId, actor.membershipId],
          );
          await db.platform.query(
            `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,0,'text','Import the file now')`,
            [conversationId, nextMessage],
          );
          await db.platform.query(
            `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,2)`,
            [nextTurn, conversationId, nextMessage],
          );
          const followUp = { ...context, origin: { ...context.origin, turnId: nextTurn } };
          await files.invokeWithSources(
            { ...followUp, callId: randomUUID() },
            {
              tool: 'tables.import.file',
              attachmentId,
              contentDigest,
              selection: JSON.stringify(selection),
            },
          );
          const followUpPlan = async table =>
            (
              await files.invokeWithSources(
                { ...followUp, callId: randomUUID() },
                { tool: 'tables.propose', input: JSON.stringify({ plans: [importPlan(table)] }) },
              )
            ).result;
          const wrong = await followUpPlan(other);
          assert.equal(wrong.error, 'table-not-found', JSON.stringify(wrong));
          const continued = await followUpPlan(definition);
          assert.equal(continued.status, 'pending', JSON.stringify(continued));
          assert.deepEqual(continued.tables, [{ id: definition.id, name: definition.label }]);
          await db.platform.query(
            `UPDATE ${s}.tf_conversation_parts SET text='Import into the existing table Missing Current Orders' WHERE message_id=$1`,
            [nextMessage],
          );
          const missing = await followUpPlan(definition);
          assert.equal(missing.error, 'table-not-found', JSON.stringify(missing));
        });
        const advance = createTableExecution({
          requireSources: requireTableSources,
          requireImportReference: requireTableImportReference,
          resolveMigrationCredential: async () => db.login(ws, 'migration'),
        });
        let state;
        for (let attempt = 0; attempt < 10; attempt++) {
          state = await advance(ws.id, output.id);
          if (state === 'completed' || state === 'blocked') break;
        }
        assert.equal(state, 'completed');
        const status = await proposals.status(ws.id, actor, conversationId, output.id);
        assert.deepEqual(status.plans[0].importProgress, { applied: 3, remaining: 0 });
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${s}."${physicalTable}"`)).rows[0].count,
          3,
        );
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${s}."${physicalTables.get(other.id)}"`)).rows[0]
            .count,
          0,
        );
      }
    }
  });
});
