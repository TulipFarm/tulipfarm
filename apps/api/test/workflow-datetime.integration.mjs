import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { activate } from '../../../packages/workflows/test/commands.fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { registerWorkflows } from '../src/workflows.ts';
import { protectBusinessRequests } from '../src/business.ts';

test(
  'one-time triggers reject past instants, fire exactly once per active revision, and delays stop when disabled',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      app = Fastify();
      protectBusinessRequests(app);
      registerWorkflows(app, {
        service,
        auth: {
          api: {
            getSession: async ({ headers }) =>
              headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
          },
        },
      });
      const base = `/workspaces/${w.id}/workflows`,
        headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const schema = `"${w.names.schema}"`;
      const steps = [{ id: 'copy', kind: 'transform', fields: { at: { kind: 'literal', value: 'fired' } } }];
      const once = at => ({ version: 1, name: 'One-time example', trigger: { kind: 'once', at }, steps });
      const elapse = (id, instant) =>
        db.platform.query(`UPDATE ${schema}.tf_workflows SET next_run_at=$2 WHERE id=$1`, [id, instant]);
      const scheduled = async id =>
        (await service.history(w.id, w.userId, id).then(page => page.runs)).filter(run => run.source === 'schedule');
      const nextRunAt = async id => (await service.list(w.id, w.userId)).find(item => item.id === id)?.nextRunAt;
      // Unattended triggers run for an explicit sponsor; the creator sponsors each revision and receives its history.
      const sponsor = id =>
        service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });

      const pastId = randomUUID();
      const past = await app.inject({
        method: 'PUT',
        url: `${base}/${pastId}`,
        headers,
        payload: {
          revision: randomUUID(),
          expectedRevision: null,
          definition: once(new Date(Date.now() - 60000).toISOString()),
        },
      });
      assert.equal(past.statusCode, 409, past.body);
      assert.deepEqual(past.json(), { error: 'schedule-in-past' });
      assert.equal(
        (await service.list(w.id, w.userId)).some(item => item.id === pastId),
        false,
        'A rejected save stores nothing',
      );

      const id = randomUUID(),
        first = randomUUID(),
        at = new Date(Date.now() + 3600000).toISOString();
      const saved = await app.inject({
        method: 'PUT',
        url: `${base}/${id}`,
        headers,
        payload: { revision: first, expectedRevision: null, definition: once(at) },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `${base}/${id}`,
            headers,
            payload: { revision: first, expectedRevision: null, definition: once(at) },
          })
        ).statusCode,
        200,
        'Retrying the same save stays idempotent',
      );
      await sponsor(id);
      assert.equal((await activate(service, w.id, w.userId, id, first, true)).nextRunAt, at);
      await service.due(w.id);
      assert.deepEqual(
        await service.history(w.id, w.userId, id).then(page => page.runs),
        [],
        'Nothing runs before the instant is due',
      );
      assert.equal(await nextRunAt(id), at);

      const elapsed = new Date(Date.now() - 1000).toISOString();
      await elapse(id, elapsed);
      await Promise.all([service.due(w.id), service.due(w.id)]);
      await service.due(w.id);
      const firstRuns = await scheduled(id);
      assert.equal(firstRuns.length, 1, 'Exactly one scheduled run is admitted');
      assert.equal(firstRuns[0].revision, first);
      assert.equal(await nextRunAt(id), null);

      await activate(service, w.id, w.userId, id, first, false);
      assert.equal(
        (await activate(service, w.id, w.userId, id, first, true)).nextRunAt,
        null,
        'Re-enabling a revision that already fired schedules nothing',
      );
      await service.due(w.id);
      assert.equal((await scheduled(id)).length, 1);

      const second = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision: second,
        expectedRevision: first,
        definition: { ...once(at), name: 'One-time example, revised' },
      });
      await sponsor(id);
      assert.equal((await activate(service, w.id, w.userId, id, second, true)).nextRunAt, at);
      await elapse(id, elapsed);
      await service.due(w.id);
      assert.deepEqual(
        (await scheduled(id)).map(run => run.revision).sort(),
        [first, second].sort(),
        'A new revision due at the same instant gets its own run',
      );
      assert.equal(await nextRunAt(id), null);

      const lateId = randomUUID(),
        late = randomUUID();
      await service.save(w.id, w.userId, lateId, { revision: late, expectedRevision: null, definition: once(at) });
      await db.platform.query(
        `UPDATE ${schema}.tf_workflow_revisions SET definition=jsonb_set(definition,'{trigger,at}',to_jsonb($2::text)) WHERE workflow_id=$1`,
        [lateId, elapsed],
      );
      await sponsor(lateId);
      assert.equal(
        (await activate(service, w.id, w.userId, lateId, late, true)).nextRunAt,
        elapsed,
        'Activating a revision whose instant passed before it ever ran fires it once',
      );
      await service.due(w.id);
      await service.due(w.id);
      assert.equal((await scheduled(lateId)).length, 1);

      const waitId = randomUUID(),
        wait = randomUUID();
      await service.save(w.id, w.userId, waitId, {
        revision: wait,
        expectedRevision: null,
        definition: { ...once(at), steps: [{ id: 'pause', kind: 'delay', seconds: 3600 }, ...steps] },
      });
      await sponsor(waitId);
      await activate(service, w.id, w.userId, waitId, wait, true);
      await elapse(waitId, elapsed);
      const work = await service.due(w.id);
      const waitingRun = (await scheduled(waitId))[0];
      assert.ok(work.some(item => item.runId === waitingRun.id));
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: waitingRun.id }), {
        kind: 'wait',
        seconds: 3600,
      });
      assert.equal((await scheduled(waitId))[0].status, 'waiting');
      await activate(service, w.id, w.userId, waitId, wait, false);
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: waitingRun.id }), { kind: 'done' });
      const blocked = (await scheduled(waitId))[0];
      assert.equal(blocked.status, 'blocked');
      assert.equal(blocked.error, 'workflow-disabled');
      assert.deepEqual(
        blocked.steps.map(step => step.status),
        ['waiting'],
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
