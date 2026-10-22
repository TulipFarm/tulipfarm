import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { providerSetupFetch } from './provider-fixture.mjs';

test(
  'durable manager commands never restore revoked activation, keys or provider credentials',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, login;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const options = {
        keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
        providerFetch: providerSetupFetch,
      };
      let service = createWorkflows(runtime, options);
      const id = randomUUID(),
        revision = randomUUID(),
        table = name => qualified(w.names.schema, name);
      const otherId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'other-admin','admin')`,
        [otherId],
      );
      const definition = {
        version: 1,
        name: 'Command replay',
        trigger: { kind: 'webhook' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 86400 }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await service.share(w.id, w.userId, id, { principal: { kind: 'person', id: otherId }, permissions: ['manage'] });
      const activation = { commandId: randomUUID(), expectedGeneration: 2, revision, enabled: true };
      const simultaneous = await Promise.all([
        service.activate(w.id, w.userId, id, activation),
        service.activate(w.id, w.userId, id, activation),
      ]);
      assert.deepEqual(
        simultaneous.map(item => item.generation),
        [3, 3],
      );
      await service.activate(w.id, 'other-admin', id, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        revision,
        enabled: false,
      });
      service = createWorkflows(runtime, options);
      assert.equal((await service.activate(w.id, w.userId, id, activation)).enabled, false);
      await assert.rejects(service.activate(w.id, w.userId, id, { ...activation, enabled: false }), /command-conflict/);
      await assert.rejects(service.activate(w.id, 'other-admin', id, activation), /command-conflict/);
      await assert.rejects(
        service.activate(w.id, w.userId, id, { ...activation, commandId: randomUUID() }),
        /stale-generation/,
      );
      await service.activate(w.id, w.userId, id, { ...activation, commandId: randomUUID(), expectedGeneration: 4 });
      const oldKey = { commandId: randomUUID(), expectedGeneration: 5, mode: 'bearer', graceSeconds: 0 };
      const first = await service.webhookKey(w.id, w.userId, id, oldKey);
      const newKey = { commandId: randomUUID(), expectedGeneration: 6, mode: 'bearer', graceSeconds: 0 };
      const second = await service.webhookKey(w.id, 'other-admin', id, newKey);
      assert.deepEqual(
        await service.webhookKey(w.id, w.userId, id, oldKey).then(({ workflow, key }) => [workflow.generation, key]),
        [7, null],
        'A replayed command never reveals or replaces a key',
      );
      const bearer = key => ({
        body: { requestId: randomUUID(), input: null },
        headers: { authorization: `Bearer ${key}` },
      });
      await assert.rejects(service.webhook(w.id, id, bearer(first.key)), AccessDenied);
      assert.match((await service.webhook(w.id, id, bearer(second.key))).runId, /^[a-f0-9-]{36}$/);
      await assert.rejects(service.webhookKey(w.id, w.userId, id, { ...oldKey, mode: 'signed' }), /command-conflict/);
      await assert.rejects(
        service.webhookKey(w.id, w.userId, id, { ...oldKey, commandId: randomUUID() }),
        /stale-generation/,
      );
      const source = {
        id: randomUUID(),
        name: 'Form',
        source: { provider: 'forms', formId: 'form1' },
        token: 'original',
        consent: true,
      };
      await service.providers.create(w.id, w.userId, source);
      await service.providers.share(w.id, w.userId, source.id, {
        principal: { kind: 'person', id: otherId },
        permissions: ['manage'],
      });
      const rotate = { commandId: randomUUID(), expectedGeneration: 1, enabled: true, token: 'rotation-one' };
      await service.providers.update(w.id, w.userId, source.id, rotate);
      await service.providers.update(w.id, w.userId, source.id, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        enabled: true,
        token: 'rotation-two',
      });
      await service.providers.update(w.id, 'other-admin', source.id, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        enabled: false,
      });
      const before = (
        await db.platform.query(`SELECT credential FROM ${table('tf_provider_integrations')} WHERE id=$1`, [source.id])
      ).rows[0];
      await service.providers.update(w.id, w.userId, source.id, rotate);
      await service.providers.create(w.id, w.userId, source);
      assert.deepEqual(
        (await service.providers.list(w.id, w.userId)).map(item => [item.generation, item.enabled]),
        [[4, false]],
      );
      assert.deepEqual(
        (
          await db.platform.query(`SELECT credential FROM ${table('tf_provider_integrations')} WHERE id=$1`, [
            source.id,
          ])
        ).rows[0],
        before,
      );
      await assert.rejects(
        service.providers.update(w.id, w.userId, source.id, { ...rotate, token: 'different' }),
        /command-conflict/,
      );
      await assert.rejects(
        service.providers.update(w.id, w.userId, source.id, { ...rotate, commandId: randomUUID() }),
        /stale-generation/,
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      await assert.rejects(service.activate(w.id, w.userId, id, activation), AccessDenied);
      await assert.rejects(service.providers.update(w.id, w.userId, source.id, rotate), AccessDenied);
      login = await connect(db.login(w));
      await denied(login, `UPDATE ${table('tf_workflow_commands')} SET request_hash='rewritten'`);
      await denied(login, `DELETE FROM ${table('tf_workflow_commands')}`);
    } finally {
      await login?.end();
      await runtime?.close();
      await db.close();
    }
  },
);

test('human waits remain actionable after fifty newer terminal runs', { timeout: 120000 }, async () => {
  const db = await fixture();
  let runtime;
  try {
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
    await service.save(w.id, w.userId, id, {
      revision,
      expectedRevision: null,
      definition: {
        version: 1,
        name: 'Long wait',
        trigger: { kind: 'manual' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Still waiting', timeoutSeconds: 86400 }],
      },
    });
    await service.activate(w.id, w.userId, id, {
      commandId: randomUUID(),
      expectedGeneration: 1,
      revision,
      enabled: true,
    });
    const oldest = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: null });
    await service.advance({ workspaceId: w.id, runId: oldest.runId });
    for (let index = 0; index < 51; index++) {
      const run = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: index });
      await service.cancel(w.id, w.userId, id, run.runId);
    }
    const history = await service.history(w.id, w.userId, id).then(page => page.runs);
    assert.equal(history.length, 51);
    assert.equal(history[0].id, oldest.runId);
    assert.equal(history[0].steps[0].prompt, 'Still waiting');
    await service.respond(w.id, w.userId, id, oldest.runId, {
      responseId: randomUUID(),
      stepId: 'review',
      output: { approved: true },
    });
    await service.advance({ workspaceId: w.id, runId: oldest.runId });
    const completed = (
      await db.platform.query(`SELECT status FROM ${qualified(w.names.schema, 'tf_workflow_runs')} WHERE id=$1`, [
        oldest.runId,
      ])
    ).rows[0];
    assert.equal(completed.status, 'completed');
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test(
  'archiving a workflow stops its triggers and runs, frees its quota slot and keeps its history',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, login;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const woken = [];
      const service = createWorkflows(runtime, {
        wake: async work => {
          woken.push(work.runId);
        },
      });
      const table = name => qualified(w.names.schema, name);
      const id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Obsolete intake',
        trigger: { kind: 'webhook' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 86400 }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        revision,
        enabled: true,
      });
      const { key } = await service.webhookKey(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        mode: 'bearer',
      });
      const { runId } = await service.webhook(w.id, id, {
        body: { requestId: randomUUID(), input: null },
        headers: { authorization: `Bearer ${key}` },
      });
      await service.advance({ workspaceId: w.id, runId });
      for (let n = 1; n < 25; n++)
        await service.save(w.id, w.userId, randomUUID(), {
          revision: randomUUID(),
          expectedRevision: null,
          definition: { ...definition, trigger: { kind: 'manual' } },
        });
      await assert.rejects(
        service.save(w.id, w.userId, randomUUID(), { revision: randomUUID(), expectedRevision: null, definition }),
        { message: 'limit-reached' },
      );

      const archive = { commandId: randomUUID(), expectedGeneration: 4 };
      await assert.rejects(service.archive(w.id, w.userId, id, { ...archive, expectedGeneration: 3 }), {
        message: 'stale-generation',
      });
      assert.deepEqual(await service.archive(w.id, w.userId, id, archive), { archived: true });
      assert.deepEqual(await service.archive(w.id, w.userId, id, archive), { archived: true });
      await assert.rejects(service.archive(w.id, w.userId, id, { commandId: randomUUID(), expectedGeneration: 5 }), {
        message: 'workflow-archived',
      });

      assert.equal(
        (await service.list(w.id, w.userId)).some(item => item.id === id),
        false,
      );
      assert.equal((await service.list(w.id, w.userId)).length, 24);
      assert.deepEqual([...new Set((await service.list(w.id, w.userId)).map(item => item.archivedAt))], [null]);
      const archivedList = await service.list(w.id, w.userId, { archived: true });
      assert.deepEqual(
        archivedList.map(item => [item.id, item.definition.name, item.enabled]),
        [[id, 'Obsolete intake', false]],
      );
      assert.match(archivedList[0].archivedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const reader = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        reader.membershipId,
        reader.userId,
      ]);
      assert.deepEqual(await service.list(w.id, reader.userId, { archived: true }), []);
      await service.share(w.id, w.userId, id, {
        principal: { kind: 'person', id: reader.membershipId },
        permissions: ['read'],
      });
      assert.deepEqual(
        (await service.list(w.id, reader.userId, { archived: true })).map(item => [item.id, item.capabilities]),
        [[id, { read: true, invoke: false, manage: false }]],
      );
      assert.deepEqual(woken, [runId]);
      const [run] = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.deepEqual(
        [run.id, run.status, run.error, run.steps.map(step => step.stepId)],
        [runId, 'blocked', 'workflow-archived', ['review']],
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT enabled,next_run_at,webhook_digest,webhook_secret,webhook_previous,archived_at IS NOT NULL AS archived,generation FROM ${table('tf_workflows')} WHERE id=$1`,
            [id],
          )
        ).rows[0],
        {
          enabled: false,
          next_run_at: null,
          webhook_digest: null,
          webhook_secret: null,
          webhook_previous: null,
          archived: true,
          generation: 5,
        },
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS count FROM ${table('tf_audit_events')} WHERE operation='workflow.archive' AND subject_id=$1`,
            [id],
          )
        ).rows[0],
        { count: 1 },
      );

      await assert.rejects(
        service.webhook(w.id, id, {
          body: { requestId: randomUUID(), input: null },
          headers: { authorization: `Bearer ${key}` },
        }),
        AccessDenied,
      );
      await assert.rejects(
        service.activate(w.id, w.userId, id, {
          commandId: randomUUID(),
          expectedGeneration: 5,
          revision,
          enabled: true,
        }),
        { message: 'workflow-archived' },
      );
      await assert.rejects(
        service.save(w.id, w.userId, id, { revision: randomUUID(), expectedRevision: revision, definition }),
        { message: 'workflow-archived' },
      );
      await assert.rejects(
        service.webhookKey(w.id, w.userId, id, { commandId: randomUUID(), expectedGeneration: 5, mode: 'bearer' }),
        { message: 'workflow-archived' },
      );
      await assert.rejects(service.start(w.id, w.userId, id, { requestId: randomUUID(), input: null }), {
        message: 'workflow-disabled',
      });
      await service.save(w.id, w.userId, randomUUID(), { revision: randomUUID(), expectedRevision: null, definition });

      login = await connect(db.login(w));
      await assert.rejects(
        login.query(`UPDATE ${table('tf_workflows')} SET enabled=true WHERE id=$1`, [id]),
        /tf_workflows_archived_disabled/,
      );
    } finally {
      await login?.end();
      await runtime?.close();
      await db.close();
    }
  },
);
