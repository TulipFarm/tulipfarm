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
import { commonCompatibility } from '../../../workspaces/src/storage.ts';

test(
  'proposal admission scopes field versions and marks same-value, ABA and restored identities stale on PostgreSQL',
  { timeout: 120000 },
  async t => {
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
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
      [chat, actor.userId, actor.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
      [message, chat, actor.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
      [turn, chat, message],
    );
    const field = randomUUID(),
      other = randomUUID(),
      revision = 'a'.repeat(40);
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: [field, other].map(id => ({
        id,
        kind: 'text',
        label: id === field ? 'Status' : 'Notes',
        required: false,
        maxLength: 10000,
      })),
      uniqueKeys: [],
    };
    await inTransaction(client, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const service = createTableService(
      runtime,
      {
        readableFiles: async () => {
          throw new Error('Unexpected file');
        },
      },
      executionCompatibility,
    );
    const options = { runtime, data: generationProposalData, requireSources: requireDraftSources };
    const proposals = createTableProposals(options);
    const decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    });
    const text = value => ({ kind: 'text', value });
    let record = await service.mutate(w.id, actor, {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: randomUUID(),
      values: { [field]: text('open'), [other]: text('initial') },
    });
    const update = async values => {
      record = await service.mutate(w.id, actor, {
        kind: 'update',
        tableId: definition.id,
        revision,
        recordId: record.id,
        expectedToken: record.token,
        values,
      });
    };
    const propose = () =>
      proposals.propose(
        w.id,
        actor,
        randomUUID(),
        { conversationId: chat, turnId: turn, sources: [] },
        {
          plans: [
            {
              kind: 'schema',
              tableId: definition.id,
              expectedRevision: revision,
              dependsOn: [],
              target: definition,
              transforms: { outputs: [{ fieldId: field, expression: { op: 'literal', value: text('closed') } }] },
            },
          ],
        },
      );
    const approve = proposal =>
      decisions.decide(w.id, actor.userId, chat, proposal.id, {
        commandId: randomUUID(),
        decision: 'approve',
        digest: proposal.digest,
      });
    const view = proposal => proposals.read(w.id, actor.userId, chat, proposal.id);
    const expectStale = async proposal => assert.equal((await view(proposal)).freshness, 'stale');
    const scoped = await propose();
    await update({ [other]: text('unrelated') });
    assert.equal((await view(scoped)).freshness, 'current');
    assert.equal((await approve(scoped)).status, 'approved');
    await update({ [field]: text('open') });
    await expectStale(scoped);
    const aba = await propose();
    await approve(aba);
    await update({ [field]: text('temporary') });
    await update({ [field]: text('open') });
    await expectStale(aba);
    const restored = await propose();
    await approve(restored);
    const history = (await service.history(w.id, actor, { tableId: definition.id, recordId: record.id })).find(
      item => item.operation === 'create',
    );
    record = await service.mutate(w.id, actor, {
      kind: 'delete',
      tableId: definition.id,
      revision,
      recordId: record.id,
      expectedToken: record.token,
    });
    await assert.rejects(
      service.mutate(w.id, actor, {
        kind: 'create',
        tableId: definition.id,
        revision,
        recordId: record.id,
        values: history.values,
      }),
      /stale-record/,
    );
    record = await service.mutate(w.id, actor, {
      kind: 'restore',
      tableId: definition.id,
      revision,
      recordId: record.id,
      expectedToken: record.token,
      historyId: history.id,
    });
    await expectStale(restored);
    const fresh = await propose();
    assert.equal((await approve(fresh)).status, 'approved');
    assert.equal((await view(fresh)).manifest.plans[0].effectCount, 1);
    await update({ [field]: text('closed') });
    const unchanged = await propose();
    assert.equal((await view(unchanged)).manifest.plans[0].effectCount, 0);
    await approve(unchanged);
    await update({ [other]: text('still unrelated') });
    assert.equal((await view(unchanged)).freshness, 'current');
    await update({ [field]: text('closed') });
    await expectStale(unchanged);
  },
);
