import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createChatTools } from '../src/tools.ts';
import { AccessDenied } from '@tulipfarm/access';
import { createChatTableProposals } from '../src/table-proposals.ts';
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
    // A new table's review holds only its structure, so chat must not call it an import.
    assert.equal(output.rowsIncluded, false);
    assert.match(output.instruction, /holds no rows, so approving it imports nothing/);
    const review = await createChatTableProposals(runtime).read(ws.id, actor, conversationId, output.id);
    assert.equal(review.manifest.plans[0].effectCount, 0);
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
    const malformed = structuredClone(input);
    malformed.plans[0].target.fields[0].id = 'vendor-name-field';
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
});
