import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';

test(
  'saving as the sponsor accepts the revision without replacing the sponsorship or active revision',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await loadPlatformBaseline(db.platform);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Order intake',
        triggers: [
          { id: 'orders', kind: 'webhook' },
          { id: 'interval', kind: 'interval', minutes: 15 },
        ],
        steps: [{ id: 'copy', kind: 'transform', fields: {} }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      let current = await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      current = await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: current.generation,
        revision,
        enabled: true,
      });
      const table = name => qualified(w.names.schema, name);
      const sponsorship = async () =>
        (await db.platform.query(`SELECT sponsorship_id FROM ${table('tf_workflows')} WHERE id=$1`, [id])).rows[0]
          .sponsorship_id;
      const originalSponsorship = await sponsorship();
      const input = {
        revision: randomUUID(),
        expectedRevision: revision,
        definition: { ...definition, triggers: [...definition.triggers, { id: 'notifications', kind: 'webhook' }] },
      };
      const saved = await service.save(w.id, w.userId, id, input);
      assert.equal(saved.sponsorshipAccepted, true);
      assert.equal(saved.activeRevision, revision);
      assert.equal(saved.enabled, true);
      assert.equal(await sponsorship(), originalSponsorship);
      assert.equal((await service.save(w.id, w.userId, id, input)).generation, saved.generation);
      const elapse = () =>
        db.platform.query(
          `UPDATE ${table('tf_workflow_triggers')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1 AND trigger_id='interval'`,
          [id],
        );
      await elapse();
      await service.due(w.id);
      const oldRun = (await service.history(w.id, w.userId, id)).runs.find(run => run.status !== 'skipped');
      assert.ok(oldRun, 'saving without activation keeps the active interval firing');
      assert.equal(oldRun.revision, revision);
      assert.deepEqual(oldRun.firedTriggerIds, ['interval']);
      assert.equal(
        (await db.platform.query(`SELECT sponsorship_id FROM ${table('tf_workflow_runs')} WHERE id=$1`, [oldRun.id]))
          .rows[0].sponsorship_id,
        originalSponsorship,
      );
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).enabled, true);
      await service.advance({ workspaceId: w.id, runId: oldRun.id });
      await service.advance({ workspaceId: w.id, runId: oldRun.id });
      const active = await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: saved.generation,
        revision: saved.revision,
        enabled: true,
      });
      assert.equal(active.activeTriggers.length, 3);

      await db.platform.query(`UPDATE ${table('tf_workflows')} SET sponsorship_id=NULL WHERE id=$1`, [id]);
      assert.equal(
        (await db.platform.query(`SELECT sponsorship_active_revision FROM ${table('tf_workflows')} WHERE id=$1`, [id]))
          .rows[0].sponsorship_active_revision,
        null,
        'revoking the sponsorship clears its active consent',
      );
      await elapse();
      await service.due(w.id);
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).enabled, false);

      const recipient = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        recipient,
        randomUUID(),
      ]);
      await service.share(w.id, w.userId, id, { principal: { kind: 'person', id: recipient }, permissions: ['read'] });
      const shared = await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId, recipient],
      });
      const sharedSponsorship = await sponsorship();
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: shared.generation,
        revision: saved.revision,
        enabled: true,
      });
      await service.share(w.id, w.userId, id, { principal: { kind: 'person', id: recipient }, permissions: [] });
      const pending = await service.save(w.id, w.userId, id, {
        revision: randomUUID(),
        expectedRevision: saved.revision,
        definition: { ...input.definition, name: 'Updated intake' },
      });
      assert.equal(pending.sponsorshipAccepted, false, 'lost audience access leaves the saved revision pending');
      assert.equal(pending.activeRevision, saved.revision);
      assert.equal(await sponsorship(), sharedSponsorship);
      assert.equal(
        (await service.list(w.id, w.userId)).find(item => item.id === id).revision,
        pending.revision,
        'failed sponsorship authorization does not roll back a valid draft save',
      );
      await elapse();
      await service.due(w.id);
      assert.equal(
        (await service.list(w.id, w.userId)).find(item => item.id === id).enabled,
        false,
        'an audience access revocation stops unattended runs',
      );
      await service.share(w.id, w.userId, id, {
        principal: { kind: 'person', id: recipient },
        permissions: ['invoke'],
      });
      await assert.rejects(
        service.sponsorship(w.id, w.userId, id, { sponsorMembershipId: recipient, historyAudience: [recipient] }),
        { message: 'sponsor-must-be-self' },
        'nobody can make another member run the workflow',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

test('a revision saved by someone else runs only after its new runner turns it on', { timeout: 60000 }, async () => {
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
      triggers: [{ id: 'interval', kind: 'interval', minutes: 1 }],
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
      permissions: ['manage', 'invoke'],
    });
    const replacement = {
      revision: replacementRevision,
      expectedRevision: reviewedRevision,
      definition: workflowDefinition('replacement'),
    };
    const saved = await service.save(w.id, manager.userId, id, replacement);
    assert.equal(saved.sponsorshipAccepted, false);
    const activation = {
      commandId: randomUUID(),
      expectedGeneration: saved.generation,
      revision: replacementRevision,
      enabled: true,
    };
    await assert.rejects(
      service.activate(w.id, manager.userId, id, activation),
      { message: 'table-step-access-denied' },
      'a manager without write access cannot turn on a workflow that writes rows',
    );
    const accepted = await service.activate(w.id, sponsor.userId, id, { ...activation, commandId: randomUUID() });
    assert.equal(accepted.sponsorshipAccepted, true);
    assert.equal(accepted.sponsorMembershipId, sponsor.membershipId, 'whoever turns it on runs it');
    assert.equal(accepted.enabled, true);
    const replay = await service.save(w.id, manager.userId, id, replacement);
    assert.equal(replay.generation, accepted.generation);
    assert.equal(replay.sponsorshipAccepted, true, 'save replay preserves accepted consent');
    const unchanged = await service.save(w.id, manager.userId, id, {
      revision: randomUUID(),
      expectedRevision: replacementRevision,
      definition: workflowDefinition('replacement'),
    });
    assert.equal(unchanged.revision, replacementRevision, 'saving an identical definition keeps the revision');
    assert.equal(unchanged.generation, accepted.generation);
    assert.equal(unchanged.sponsorshipAccepted, true, 'saving an identical definition keeps consent');
    await db.platform.query(
      `UPDATE ${table('tf_workflow_triggers')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1`,
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
    assert.equal(
      (await service.save(w.id, manager.userId, id, initial)).generation,
      changed.generation,
      'replaying an old save does not change current state',
    );
    await db.platform.query(
      `UPDATE ${table('tf_workflow_triggers')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1`,
      [id],
    );
    await service.due(w.id);
    const kept = (await service.history(w.id, sponsor.userId, id)).runs.find(
      item => item.id !== run.id && item.status !== 'skipped',
    );
    assert.ok(kept, 'a non-sponsor save keeps the previously accepted active revision running');
    assert.equal(kept.revision, replacementRevision);
    assert.equal((await service.list(w.id, manager.userId)).find(item => item.id === id).sponsorshipAccepted, false);
    for (let attempt = 0; attempt < 5; attempt++)
      if ((await service.advance({ workspaceId: w.id, runId: kept.id })).kind === 'done') break;
    await db.platform.query(
      `DELETE FROM ${table('tf_grants')} WHERE team_id=$1 AND asset_id=$2 AND permission='table.row.create'`,
      [sponsor.teamId, definition.id],
    );
    await db.platform.query(
      `UPDATE ${table('tf_workflow_triggers')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1`,
      [id],
    );
    await service.due(w.id);
    assert.equal(
      (await service.list(w.id, manager.userId)).find(item => item.id === id).enabled,
      false,
      'the active-consent marker never bypasses current source access',
    );
    await service.share(w.id, manager.userId, id, {
      principal: { kind: 'person', id: sponsor.membershipId },
      permissions: ['manage', 'invoke'],
    });
    const pending = await service.save(w.id, sponsor.userId, id, {
      revision: randomUUID(),
      expectedRevision: changed.revision,
      definition: workflowDefinition('saved without write access'),
    });
    assert.equal(pending.sponsorshipAccepted, false);
    assert.equal(pending.enabled, false);
    assert.equal(pending.activeRevision, replacementRevision);
    assert.equal(
      (await service.list(w.id, sponsor.userId)).find(item => item.id === id).revision,
      pending.revision,
      'a sponsor without source write access can still save a readable draft',
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.create')`,
      [sponsor.teamId, definition.id],
    );
    await service.sponsorship(w.id, sponsor.userId, id, {
      sponsorMembershipId: sponsor.membershipId,
      historyAudience: [sponsor.membershipId, manager.membershipId],
    });
    await db.platform.query(
      `DELETE FROM ${table('tf_grants')} WHERE team_id=$1 AND asset_id=$2 AND permission='table.row.read'`,
      [manager.teamId, definition.id],
    );
    const audiencePending = await service.save(w.id, sponsor.userId, id, {
      revision: randomUUID(),
      expectedRevision: pending.revision,
      definition: workflowDefinition('saved without audience source access'),
    });
    assert.equal(audiencePending.sponsorshipAccepted, false);
    assert.equal(audiencePending.enabled, false);
    assert.equal(
      (await service.list(w.id, sponsor.userId)).find(item => item.id === id).revision,
      audiencePending.revision,
      'lost audience source access leaves a saved draft pending',
    );
  } finally {
    await migration?.end();
    await runtime?.close();
    await db.close();
  }
});

test(
  'a manager who turns the workflow on runs it and can still save after losing invoke access',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    try {
      await loadPlatformBaseline(db.platform);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      const nominee = { membershipId: randomUUID(), userId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        nominee.membershipId,
        nominee.userId,
      ]);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Scheduled intake',
        triggers: [{ id: 'interval', kind: 'interval', minutes: 15 }],
        steps: [{ id: 'copy', kind: 'transform', fields: {} }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.share(w.id, w.userId, id, {
        principal: { kind: 'person', id: nominee.membershipId },
        permissions: ['manage', 'invoke'],
      });
      const consent = async () =>
        (
          await db.platform.query(
            `SELECT sponsorship_id,sponsorship_revision FROM ${table('tf_workflows')} WHERE id=$1`,
            [id],
          )
        ).rows[0];
      const acceptAudits = async () =>
        (
          await db.platform.query(
            `SELECT count(*)::integer AS count FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation='workflow.sponsor'`,
            [id],
          )
        ).rows[0].count;
      const pending = await service.save(w.id, nominee.userId, id, {
        revision: randomUUID(),
        expectedRevision: revision,
        definition: { ...definition, name: 'Reviewed intake' },
      });
      assert.equal(pending.sponsorshipAccepted, false);
      assert.equal(pending.enabled, false);
      assert.deepEqual(await consent(), { sponsorship_id: null, sponsorship_revision: null });
      assert.equal(await acceptAudits(), 0);
      const accepted = await service.activate(w.id, nominee.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: pending.generation,
        revision: pending.revision,
        enabled: true,
      });
      assert.equal(accepted.sponsorshipAccepted, true);
      assert.equal(accepted.sponsorMembershipId, nominee.membershipId);
      assert.equal(await acceptAudits(), 1);
      const acceptedConsent = await consent();
      await service.share(w.id, w.userId, id, {
        principal: { kind: 'person', id: nominee.membershipId },
        permissions: ['manage'],
      });
      const withoutInvoke = await service.save(w.id, nominee.userId, id, {
        revision: randomUUID(),
        expectedRevision: accepted.revision,
        definition: { ...definition, name: 'Draft intake' },
      });
      assert.equal(withoutInvoke.sponsorshipAccepted, false);
      assert.equal(withoutInvoke.activeRevision, accepted.revision);
      assert.deepEqual(await consent(), acceptedConsent);
      assert.equal(await acceptAudits(), 1);
      assert.equal(
        (await service.list(w.id, nominee.userId)).find(item => item.id === id).revision,
        withoutInvoke.revision,
      );
      await db.platform.query(
        `UPDATE ${table('tf_workflow_triggers')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1`,
        [id],
      );
      await service.due(w.id);
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).enabled, false);
      await t.test('a sponsor without management access still cannot save a revision', async () => {
        await service.share(w.id, w.userId, id, {
          principal: { kind: 'person', id: nominee.membershipId },
          permissions: ['invoke'],
        });
        const attemptedRevision = randomUUID();
        await assert.rejects(
          service.save(w.id, nominee.userId, id, {
            revision: attemptedRevision,
            expectedRevision: withoutInvoke.revision,
            definition: { ...definition, name: 'Unauthorized edit' },
          }),
          AccessDenied,
        );
        assert.equal(
          (await service.list(w.id, w.userId)).find(item => item.id === id).revision,
          withoutInvoke.revision,
        );
        assert.equal(
          (await db.platform.query(`SELECT id FROM ${table('tf_workflow_revisions')} WHERE id=$1`, [attemptedRevision]))
            .rowCount,
          0,
        );
        assert.deepEqual(await consent(), acceptedConsent);
      });
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
