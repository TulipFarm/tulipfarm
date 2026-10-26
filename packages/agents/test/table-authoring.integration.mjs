import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    const output = (await tools.invokeWithSources(context, { tool: 'tables.propose', input: JSON.stringify(input) }))
      .result;
    assert.equal(output.status, 'pending');
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
});
