import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';

test(
  'sponsorship consent cannot approve a revision saved after the sponsor reviewed it',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, migration;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const migrations = await workspaceTableMigrations();
      const w = await db.create(migrations);
      const table = name => qualified(w.names.schema, name);
      const manager = { userId: randomUUID(), membershipId: randomUUID(), teamId: randomUUID() };
      const sponsor = { userId: randomUUID(), membershipId: randomUUID(), teamId: randomUUID() };
      for (const [name, person] of [
        ['Manager', manager],
        ['Sponsor', sponsor],
      ]) {
        await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
          person.membershipId,
          person.userId,
        ]);
        await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,$2)`, [person.teamId, name]);
        await db.platform.query(`INSERT INTO ${table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
          person.membershipId,
          person.teamId,
        ]);
      }
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      migration = await connect(db.login(w, 'migration'));
      const tableRevision = '1'.repeat(40),
        fieldId = randomUUID();
      const definition = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: sponsor.teamId,
        label: 'Consented rows',
        fields: [{ id: fieldId, label: 'Value', required: false, kind: 'text', maxLength: 200 }],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, { definition, revision: tableRevision });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });
      await db.platform.query(
        `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission)
      VALUES($1,$3,'table.row.read'),($2,$3,'table.row.read'),($2,$3,'table.row.create')`,
        [manager.teamId, sponsor.teamId, definition.id],
      );
      const rows = createTableService(
        runtime,
        { readableFiles: async () => new Set() },
        { minimum: migrations.length, maximum: migrations.length },
      );
      await assert.rejects(
        rows.mutate(w.id, manager.userId, {
          kind: 'create',
          tableId: definition.id,
          revision: tableRevision,
          recordId: randomUUID(),
          values: { [fieldId]: { kind: 'text', value: 'direct' } },
        }),
        AccessDenied,
      );

      const service = createWorkflows(runtime);
      const id = randomUUID(),
        reviewedRevision = randomUUID(),
        replacementRevision = randomUUID();
      const workflowDefinition = value => ({
        version: 1,
        name: 'Consented write',
        trigger: { kind: 'interval', minutes: 1 },
        steps: [
          {
            id: 'create',
            kind: 'create-row',
            tableId: definition.id,
            fields: { [fieldId]: { kind: 'literal', value } },
          },
        ],
      });
      const initial = {
        revision: reviewedRevision,
        expectedRevision: null,
        definition: workflowDefinition('reviewed'),
      };
      assert.equal((await service.save(w.id, manager.userId, id, initial)).generation, 1);
      await service.share(w.id, manager.userId, id, {
        principal: { kind: 'person', id: sponsor.membershipId },
        permissions: ['invoke'],
      });
      const requested = await service.sponsorship(w.id, manager.userId, id, {
        sponsorMembershipId: sponsor.membershipId,
        historyAudience: [sponsor.membershipId],
      });
      const oldConsent = { expectedGeneration: requested.generation };
      assert.equal(
        (await service.save(w.id, manager.userId, id, initial)).generation,
        requested.generation,
        'save replay does not invalidate consent',
      );
      const replacement = {
        revision: replacementRevision,
        expectedRevision: reviewedRevision,
        definition: workflowDefinition('replacement'),
      };
      const saved = await service.save(w.id, manager.userId, id, replacement);
      await assert.rejects(service.acceptSponsorship(w.id, sponsor.userId, id, oldConsent), {
        message: 'stale-generation',
      });
      assert.equal(saved.generation, requested.generation + 1);
      assert.equal(saved.sponsorshipAccepted, false);
      const activation = {
        commandId: randomUUID(),
        expectedGeneration: saved.generation,
        revision: replacementRevision,
        enabled: true,
      };
      await assert.rejects(
        service.activate(w.id, manager.userId, id, activation),
        AccessDenied,
        'the replacement cannot run before fresh consent',
      );
      const freshConsent = { expectedGeneration: saved.generation };
      const accepted = await service.acceptSponsorship(w.id, sponsor.userId, id, freshConsent);
      assert.equal(accepted.sponsorshipAccepted, true);
      assert.equal(
        (await service.acceptSponsorship(w.id, sponsor.userId, id, freshConsent)).generation,
        accepted.generation,
        'acceptance replay is idempotent',
      );
      const replay = await service.save(w.id, manager.userId, id, replacement);
      assert.equal(replay.generation, accepted.generation);
      assert.equal(replay.sponsorshipAccepted, true, 'save replay preserves accepted consent');
      await service.activate(w.id, manager.userId, id, { ...activation, expectedGeneration: accepted.generation });
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [id],
      );
      await service.due(w.id);
      const run = (await service.history(w.id, sponsor.userId, id)).runs.find(item => item.status !== 'skipped');
      assert.ok(run);
      for (let attempt = 0; attempt < 5; attempt++)
        if ((await service.advance({ workspaceId: w.id, runId: run.id })).kind === 'done') break;
      const completed = (await service.history(w.id, sponsor.userId, id)).runs.find(item => item.id === run.id);
      assert.equal(completed.status, 'completed');
      const recordId = completed.steps[0].output.recordId;
      assert.equal(
        (await rows.read(w.id, sponsor.userId, { tableId: definition.id, revision: tableRevision, recordId })).values[
          fieldId
        ].value,
        'replacement',
      );
      assert.equal(
        (await rows.history(w.id, sponsor.userId, { tableId: definition.id, recordId }))[0].actor.membershipId,
        sponsor.membershipId,
      );

      const changed = await service.save(w.id, manager.userId, id, {
        revision: randomUUID(),
        expectedRevision: replacementRevision,
        definition: workflowDefinition('changed again'),
      });
      assert.equal(changed.activeRevision, replacementRevision, 'saving does not change the active revision');
      assert.equal(changed.sponsorshipAccepted, false);
      await assert.rejects(
        service.acceptSponsorship(w.id, sponsor.userId, id, freshConsent),
        { message: 'stale-generation' },
        'replaying earlier consent cannot approve another edit',
      );
      assert.equal(
        (await service.save(w.id, manager.userId, id, initial)).generation,
        changed.generation,
        'replaying an old save does not change current state',
      );
    } finally {
      await migration?.end();
      await runtime?.close();
      await db.close();
    }
  },
);
