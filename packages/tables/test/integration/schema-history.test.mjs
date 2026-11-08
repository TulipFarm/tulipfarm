import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createGeneration, activateGeneration, generationProposalData } from '../../../tables/dist/store.js';
import { createTableProposals } from '../../../tables/dist/proposals.js';
import { requireTableSources } from '../../../agents/src/table-sources.ts';
import { createTableSchemaHistory } from '../../../../apps/api/src/table-schema-history.ts';

test('schema history shows published definitions to every table reader and says why others are withheld', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations()),
    s = `"${w.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const reader = randomUUID(),
    chat = randomUUID(),
    turn = randomUUID(),
    message = randomUUID(),
    team = randomUUID(),
    field = randomUUID(),
    revision = 'a'.repeat(40);
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
    randomUUID(),
    reader,
  ]);
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'History')`, [team]);
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
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'History',
    fields: [{ id: field, kind: 'text', label: 'Notes', required: false, maxLength: 1000 }],
    uniqueKeys: [],
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
  const options = { runtime, data: generationProposalData, requireSources: requireTableSources };
  const proposals = createTableProposals(options);
  const origin = {
    conversationId: chat,
    turnId: turn,
    sources: [{ kind: 'private-conversation', conversationId: chat }],
  };
  const propose = label =>
    proposals.propose(w.id, actor, randomUUID(), origin, {
      plans: [
        {
          kind: 'schema',
          tableId: definition.id,
          expectedRevision: revision,
          dependsOn: [],
          target: { ...definition, fields: [{ ...definition.fields[0], label }] },
          transforms: { outputs: [] },
        },
      ],
    });
  const execution = async (label, phase, executionRevision) => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_table_executions(proposal_id,table_id,id,publication_id,phase,revision) VALUES($1,$2,$3,$4,$5,$6)`,
      [(await propose(label)).id, definition.id, id, randomUUID(), phase, executionRevision],
    );
    return id;
  };
  const published = await execution('Remarks', 'completed', revision);
  const blocked = await execution('Blocked', 'blocked', null);
  const running = await execution('Running', 'copying', null);

  const history = createTableSchemaHistory(options);
  const read = async userId =>
    new Map((await history.history(w.id, userId, definition.id, { limit: 10 })).entries.map(e => [e.id, e]));
  const others = await read(reader);
  assert.deepEqual(others.get(published).definition, definition, 'Published definitions ignore chat sources');
  assert.equal(others.get(published).definitionWithheld, null);
  assert.equal(others.get(blocked).definition, null);
  assert.equal(others.get(blocked).definitionWithheld, 'blocked-before-save');
  assert.equal(others.get(running).definition, null, 'Unsaved proposal content keeps its source rules');
  assert.equal(others.get(running).definitionWithheld, 'source-access');
  const owner = await read(actor.userId);
  assert.equal(owner.get(running).definition.fields[0].label, 'Running');
  assert.equal(owner.get(running).definitionWithheld, null);
  assert.equal(owner.get(blocked).definition.fields[0].label, 'Blocked');
});
