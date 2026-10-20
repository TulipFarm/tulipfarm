import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied, requireProtectedSource } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';
import { providerServer } from './provider-fixture.mjs';

test(
  'ordinary creators, person/team grants, private requester histories, sponsored triggers and revocation use restricted storage',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, provider;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      const person = async role => {
        const userId = randomUUID(),
          membershipId = randomUUID();
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
          membershipId,
          userId,
          role,
        ]);
        return { userId, membershipId };
      };
      const creator = await person('member'),
        requester = await person('member'),
        manager = await person('member');
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      provider = await providerServer(() => ({
        body: {
          spreadsheetId: 'sheet',
          values: [
            ['key', 'value'],
            ['row1', 'private'],
          ],
        },
      }));
      const service = createWorkflows(runtime, {
        keyring: { activeKeyId: 'test', keys: { test: '07'.repeat(32) } },
        providerFetch: provider.fetch,
      });
      const id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Private review',
        trigger: { kind: 'manual' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Decide', timeoutSeconds: 60 }],
      };
      const saved = await service.save(w.id, creator.userId, id, { revision, expectedRevision: null, definition });
      assert.deepEqual(saved.capabilities, { read: true, invoke: true, manage: true });
      assert.deepEqual(await service.list(w.id, w.userId), []);
      const share = (target, permissions) =>
        service.share(w.id, creator.userId, id, {
          principal: { kind: 'person', id: target.membershipId },
          permissions,
        });
      const input = { requestId: randomUUID(), input: 'private' };
      for (const attempt of [
        () => service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition }),
        () =>
          service.activate(w.id, w.userId, id, {
            commandId: randomUUID(),
            expectedGeneration: 1,
            revision,
            enabled: true,
          }),
        () => service.start(w.id, w.userId, id, input),
        () => service.history(w.id, w.userId, id).then(page => page.runs),
        () =>
          service.share(w.id, w.userId, id, {
            principal: { kind: 'person', id: w.membershipId },
            permissions: ['manage'],
          }),
        () => service.grants(w.id, w.userId, id),
        () => service.providers.status(w.id, w.userId, id),
      ])
        await assert.rejects(attempt, AccessDenied);
      await activate(service, w.id, creator.userId, id, revision, true);
      await share(requester, ['invoke']);
      await share(manager, ['manage']);
      assert.deepEqual((await service.list(w.id, requester.userId))[0].capabilities, {
        read: true,
        invoke: true,
        manage: false,
      });
      await assert.rejects(service.start(w.id, manager.userId, id, input), AccessDenied);
      const first = await service.start(w.id, creator.userId, id, input);
      const second = await service.start(w.id, requester.userId, id, { ...input, input: 'requester secret' });
      assert.notEqual(first.runId, second.runId, 'request keys are private to each membership');
      await service.advance({ workspaceId: w.id, runId: first.runId });
      await service.advance({ workspaceId: w.id, runId: second.runId });
      assert.deepEqual(
        (await service.history(w.id, creator.userId, id).then(page => page.runs)).map(run => run.id),
        [first.runId],
      );
      assert.deepEqual(
        (await service.history(w.id, requester.userId, id).then(page => page.runs)).map(run => run.id),
        [second.runId],
      );
      assert.deepEqual(await service.history(w.id, manager.userId, id).then(page => page.runs), []);
      const privateDetail = await service.runDetail(w.id, requester.userId, id, second.runId);
      assert.deepEqual(privateDetail.definition, definition);
      assert.equal(privateDetail.actor.id, requester.membershipId);
      assert.deepEqual(privateDetail.run, (await service.history(w.id, requester.userId, id)).runs[0]);
      await assert.rejects(service.runDetail(w.id, creator.userId, id, second.runId), AccessDenied);
      await assert.rejects(service.runDetail(w.id, manager.userId, id, second.runId), AccessDenied);
      await assert.rejects(service.runDetail(w.id, requester.userId, randomUUID(), second.runId), AccessDenied);
      await assert.rejects(service.runDetail(w.id, requester.userId, id, randomUUID()), AccessDenied);
      const unusedRevision = randomUUID(),
        currentRevision = randomUUID();
      await service.save(w.id, creator.userId, id, {
        revision: unusedRevision,
        expectedRevision: revision,
        definition: { ...definition, name: 'Never activated' },
      });
      await service.save(w.id, creator.userId, id, {
        revision: currentRevision,
        expectedRevision: unusedRevision,
        definition: { ...definition, name: 'Saved changes' },
      });
      assert.equal((await service.definition(w.id, requester.userId, id)).definition.name, 'Saved changes');
      assert.deepEqual(
        (await service.definition(w.id, requester.userId, id, { revision: 'active' })).definition,
        definition,
      );
      assert.equal((await service.definition(w.id, requester.userId, id)).activeRevision, revision);
      assert.deepEqual((await service.runDetail(w.id, requester.userId, id, second.runId)).definition, definition);
      await assert.rejects(
        service.definition(w.id, creator.userId, id, { revision: unusedRevision }),
        AccessDenied,
        'workflow-only access does not expose arbitrary historical revisions',
      );
      await requireProtectedSource(
        { client: db.platform, schema: w.names.schema },
        { kind: 'human', ...requester },
        { kind: 'workflow-definition', workflowId: id, revision: currentRevision },
      );
      for (const user of [requester.userId, manager.userId, w.userId]) {
        await assert.rejects(service.cancel(w.id, user, id, first.runId), AccessDenied);
        await assert.rejects(
          service.respond(w.id, user, id, first.runId, { stepId: 'review', responseId: randomUUID(), output: 'steal' }),
          AccessDenied,
        );
      }
      await service.respond(w.id, creator.userId, id, first.runId, {
        stepId: 'review',
        responseId: randomUUID(),
        output: 'approved',
      });
      await service.advance({ workspaceId: w.id, runId: first.runId });
      await share(requester, []);
      await assert.rejects(service.definition(w.id, requester.userId, id), AccessDenied);
      await assert.rejects(service.runDetail(w.id, requester.userId, id, second.runId), AccessDenied);
      await assert.rejects(
        requireProtectedSource(
          { client: db.platform, schema: w.names.schema },
          { kind: 'human', ...requester },
          { kind: 'workflow-definition', workflowId: id, revision: currentRevision },
        ),
        AccessDenied,
      );
      await service.advance({ workspaceId: w.id, runId: second.runId });
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${table('tf_workflow_runs')} WHERE id=$1`, [second.runId])).rows[0]
          .status,
        'blocked',
      );
      const team = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Review team')`, [team]);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} VALUES ($1,$3),($2,$3)`, [
        creator.membershipId,
        requester.membershipId,
        team,
      ]);
      await service.share(w.id, creator.userId, id, {
        principal: { kind: 'team', id: team },
        permissions: ['read', 'invoke'],
      });
      assert.equal((await service.list(w.id, requester.userId)).length, 1);
      assert.deepEqual(await service.list(w.id, w.userId), []);
      await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [
        requester.membershipId,
      ]);
      assert.deepEqual(await service.list(w.id, requester.userId), []);
      await assert.rejects(
        service.share(w.id, manager.userId, id, { principal: { kind: 'team', id: team }, permissions: ['read'] }),
        AccessDenied,
        'managers cannot grant to teams they do not belong to',
      );
      await service.share(w.id, manager.userId, id, { principal: { kind: 'team', id: team }, permissions: [] });
      assert.deepEqual(
        (await service.grants(w.id, creator.userId, id)).filter(grant => grant.teamId === team),
        [],
        'any manager can revoke a team grant',
      );
      await service.share(w.id, creator.userId, id, { principal: { kind: 'team', id: team }, permissions: ['read'] });
      await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE team_id=$1`, [team]);
      await db.platform.query(`DELETE FROM ${table('tf_teams')} WHERE id=$1`, [team]);
      assert.deepEqual(
        (await service.grants(w.id, creator.userId, id)).filter(grant => grant.teamId === team),
        [],
        'team deletion removes its workflow grants',
      );
      const scheduled = randomUUID(),
        scheduledRevision = randomUUID();
      await service.save(w.id, creator.userId, scheduled, {
        revision: scheduledRevision,
        expectedRevision: null,
        definition: { ...definition, trigger: { kind: 'interval', minutes: 1 } },
      });
      await assert.rejects(activate(service, w.id, creator.userId, scheduled, scheduledRevision, true), AccessDenied);
      await service.share(w.id, creator.userId, scheduled, {
        principal: { kind: 'person', id: requester.membershipId },
        permissions: ['invoke'],
      });
      await service.share(w.id, creator.userId, scheduled, {
        principal: { kind: 'person', id: manager.membershipId },
        permissions: ['manage'],
      });
      await service.sponsorship(w.id, creator.userId, scheduled, {
        sponsorMembershipId: requester.membershipId,
        historyAudience: [requester.membershipId],
      });
      await assert.rejects(activate(service, w.id, creator.userId, scheduled, scheduledRevision, true), AccessDenied);
      await assert.rejects(
        service.acceptSponsorship(w.id, creator.userId, scheduled, { expectedGeneration: 2 }),
        AccessDenied,
      );
      await assert.rejects(
        service.acceptSponsorship(w.id, requester.userId, scheduled, { expectedGeneration: 1 }),
        /stale-generation/,
      );
      await service.acceptSponsorship(w.id, requester.userId, scheduled, { expectedGeneration: 2 });
      await activate(service, w.id, creator.userId, scheduled, scheduledRevision, true);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [scheduled],
      );
      await service.due(w.id);
      const scheduledRun = (await service.history(w.id, requester.userId, scheduled).then(page => page.runs)).find(
        run => run.status !== 'skipped',
      );
      assert.ok(scheduledRun);
      assert.deepEqual(await service.history(w.id, creator.userId, scheduled).then(page => page.runs), []);
      assert.deepEqual(await service.history(w.id, manager.userId, scheduled).then(page => page.runs), []);
      await service.advance({ workspaceId: w.id, runId: scheduledRun.id });
      await service.share(w.id, creator.userId, scheduled, {
        principal: { kind: 'person', id: requester.membershipId },
        permissions: ['read'],
      });
      await service.advance({ workspaceId: w.id, runId: scheduledRun.id });
      const attempted = async () =>
        (await service.history(w.id, requester.userId, scheduled).then(page => page.runs))
          .filter(run => run.status !== 'skipped')
          .map(run => [run.status, run.error]);
      assert.deepEqual(await attempted(), [['blocked', 'authority-revoked']]);
      const beforeSweep = (await service.list(w.id, creator.userId)).find(item => item.id === scheduled);
      assert.equal(beforeSweep.disabledReason, null);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [scheduled],
      );
      for (const work of await service.due(w.id)) await service.advance(work);
      assert.deepEqual(
        await attempted(),
        [
          ['blocked', 'authority-revoked'],
          ['blocked', 'authority-revoked'],
        ],
        'the sweep records the revoked occurrence',
      );
      const stopped = (await service.list(w.id, creator.userId)).find(item => item.id === scheduled);
      assert.deepEqual(
        { enabled: stopped.enabled, generation: stopped.generation, disabledReason: stopped.disabledReason },
        { enabled: false, generation: beforeSweep.generation + 1, disabledReason: 'sponsor-access-lost' },
        'a sponsor without invoke stops the schedule and open clients see a new generation',
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT actor_id,operation FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation LIKE 'workflow.disable%'`,
            [scheduled],
          )
        ).rows,
        [{ actor_id: 'system:workflow-sweep', operation: 'workflow.disable.sponsor-access-lost' }],
        'the sweep records why it stopped the workflow',
      );
      await assert.rejects(
        service.activate(w.id, creator.userId, scheduled, {
          commandId: randomUUID(),
          expectedGeneration: beforeSweep.generation,
          revision: scheduledRevision,
          enabled: false,
        }),
        /stale-generation/,
        'a client holding the pre-sweep generation must reload',
      );
      const previousHistory = (await service.history(w.id, requester.userId, scheduled).then(page => page.runs)).map(
        run => run.id,
      );
      await service.sponsorship(w.id, creator.userId, scheduled, {
        sponsorMembershipId: creator.membershipId,
        historyAudience: [creator.membershipId],
      });
      assert.equal(
        (await service.list(w.id, creator.userId)).find(item => item.id === scheduled).disabledReason,
        null,
        'a sponsor handoff supersedes the lost-access reason',
      );
      await activate(service, w.id, creator.userId, scheduled, scheduledRevision, true);
      assert.deepEqual(
        await service.history(w.id, creator.userId, scheduled).then(page => page.runs),
        [],
        'handoff does not share previous history',
      );
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [scheduled],
      );
      await service.due(w.id);
      assert.deepEqual(
        (await service.history(w.id, creator.userId, scheduled).then(page => page.runs))
          .filter(run => run.status !== 'skipped')
          .map(run => run.status),
        ['queued'],
      );
      assert.deepEqual(
        (await service.history(w.id, requester.userId, scheduled).then(page => page.runs)).map(run => run.id),
        previousHistory,
        'handoff does not share new history with the previous audience',
      );
      assert.equal(
        (await service.runDetail(w.id, requester.userId, scheduled, scheduledRun.id)).actor.id,
        requester.membershipId,
        'a historical actor is not replaced by the current sponsor',
      );

      const integrationId = randomUUID();
      await service.providers.create(w.id, creator.userId, {
        id: integrationId,
        name: 'Private sheet',
        source: { provider: 'sheets', spreadsheetId: 'sheet', range: 'A1:B3', keyColumn: 0 },
        token: 'local-token',
        consent: true,
      });
      assert.deepEqual(await service.providers.list(w.id, w.userId), []);
      await assert.rejects(
        service.providers.share(w.id, w.userId, integrationId, {
          principal: { kind: 'person', id: w.membershipId },
          permissions: ['manage'],
        }),
        AccessDenied,
      );
      await assert.rejects(
        service.providers.update(w.id, w.userId, integrationId, {
          commandId: randomUUID(),
          expectedGeneration: 1,
          enabled: false,
        }),
        AccessDenied,
      );
      await service.providers.share(w.id, creator.userId, integrationId, {
        principal: { kind: 'person', id: requester.membershipId },
        permissions: ['use'],
      });
      const providerId = randomUUID(),
        providerRevision = randomUUID();
      await service.save(w.id, creator.userId, providerId, {
        revision: providerRevision,
        expectedRevision: null,
        definition: { ...definition, trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 } },
      });
      await service.share(w.id, creator.userId, providerId, {
        principal: { kind: 'person', id: requester.membershipId },
        permissions: ['invoke'],
      });
      await service.sponsorship(w.id, creator.userId, providerId, {
        sponsorMembershipId: creator.membershipId,
        historyAudience: [requester.membershipId],
      });
      await activate(service, w.id, creator.userId, providerId, providerRevision, true);
      await service.providers.poll(w.id);
      assert.ok(provider.requests.length, 'real local HTTP provider called');
      await db.platform.query(
        `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload) VALUES ($1,$2,'test-event','{"secret":true}')`,
        [providerId, providerRevision],
      );
      await service.due(w.id);
      assert.equal((await service.history(w.id, requester.userId, providerId).then(page => page.runs)).length, 1);
      assert.deepEqual(await service.history(w.id, creator.userId, providerId).then(page => page.runs), []);
      await service.providers.share(w.id, creator.userId, integrationId, {
        principal: { kind: 'person', id: requester.membershipId },
        permissions: [],
      });
      assert.deepEqual(
        await service.history(w.id, requester.userId, providerId).then(page => page.runs),
        [],
        'history audience cannot bypass source permission',
      );
      await assert.rejects(service.definition(w.id, requester.userId, providerId), AccessDenied);
      await assert.rejects(
        requireProtectedSource(
          { client: db.platform, schema: w.names.schema },
          { kind: 'human', ...requester },
          { kind: 'workflow-provider', integrationId, generation: 1 },
        ),
        AccessDenied,
      );
      const polledId = randomUUID(),
        polledRevision = randomUUID();
      await service.save(w.id, creator.userId, polledId, {
        revision: polledRevision,
        expectedRevision: null,
        definition: { ...definition, trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 } },
      });
      await service.sponsorship(w.id, creator.userId, polledId, {
        sponsorMembershipId: creator.membershipId,
        historyAudience: [creator.membershipId],
      });
      await activate(service, w.id, creator.userId, polledId, polledRevision, true);
      const generations = async () =>
        Object.fromEntries(
          (await service.list(w.id, creator.userId))
            .filter(item => [providerId, polledId].includes(item.id))
            .map(item => [item.id, [item.generation, item.disabledReason]]),
        );
      const beforeLoss = await generations();
      await db.platform.query(
        `DELETE FROM ${table('tf_workflow_provider_grants')} WHERE integration_id=$1 AND membership_id=$2 AND permission='use'`,
        [integrationId, creator.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload) VALUES ($1,$2,'after-loss-1','{}'),($1,$2,'after-loss-2','{}')`,
        [providerId, providerRevision],
      );
      await service.due(w.id);
      await db.platform.query(
        `UPDATE ${table('tf_provider_polls')} SET next_poll=clock_timestamp()-interval '1 minute' WHERE workflow_id=$1`,
        [polledId],
      );
      await service.providers.poll(w.id);
      assert.deepEqual(
        await generations(),
        {
          [providerId]: [beforeLoss[providerId][0] + 1, 'sponsor-access-lost'],
          [polledId]: [beforeLoss[polledId][0] + 1, 'sponsor-access-lost'],
        },
        'the event sweep and the provider poll each stop a workflow whose sponsor lost the integration',
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT subject_id,count(*)::integer AS count FROM ${table('tf_audit_events')} WHERE operation='workflow.disable.sponsor-access-lost' AND subject_id = ANY($1::uuid[]) GROUP BY subject_id ORDER BY subject_id`,
            [[providerId, polledId]],
          )
        ).rows,
        [providerId, polledId].sort().map(subject_id => ({ subject_id, count: 1 })),
        'two events for one workflow record one disable',
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        creator.membershipId,
      ]);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [scheduled],
      );
      await service.due(w.id);
      assert.equal(
        (await db.platform.query(`SELECT enabled FROM ${table('tf_workflows')} WHERE id=$1`, [scheduled])).rows[0]
          .enabled,
        false,
      );
      assert.deepEqual(await service.list(w.id, w.userId), []);
    } finally {
      await provider?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
