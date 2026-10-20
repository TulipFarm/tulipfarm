import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { escapeIdentifier } from 'pg';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { registerWorkflows } from '../src/workflows.ts';
import { protectBusinessRequests } from '../src/business.ts';

const steps = [{ id: 'copy', kind: 'transform', fields: { at: { kind: 'input', path: ['scheduledFor'] } } }];
const definition = (name, trigger) => ({ version: 1, name, trigger, steps });
const minutesFromNow = iso => (Date.parse(iso) - Date.now()) / 60000;

test(
  'cron and interval workflows fire from the schedule sweep, collapse missed ticks, skip overlap, and stop when disabled',
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
      const base = `/workspaces/${w.id}/workflows`;
      const headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const workflows = `${escapeIdentifier(w.names.schema)}.tf_workflows`;
      const memberships = `${escapeIdentifier(w.names.schema)}.tf_memberships`;
      const operator = { id: 'workflow-schedule-operator', membershipId: randomUUID() };
      await db.databaseAdmin.query(`INSERT INTO ${memberships} (id,user_id,role) VALUES ($1,$2,'member')`, [
        operator.membershipId,
        operator.id,
      ]);
      const elapse = (id, interval = '3 hours') =>
        db.databaseAdmin.query(`UPDATE ${workflows} SET next_run_at=clock_timestamp()-$2::interval WHERE id=$1`, [
          id,
          interval,
        ]);
      const http = async (method, url, payload) => {
        const response = await app.inject({ method, url, headers, payload });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      };
      const save = (id, trigger, expectedRevision = null) =>
        http('PUT', `${base}/${id}`, {
          revision: randomUUID(),
          expectedRevision,
          definition: definition(`${trigger.kind} example`, trigger),
        });
      const grant = (id, membershipId, permissions = ['read', 'invoke']) =>
        http('PUT', `${base}/${id}/grants`, { principal: { kind: 'person', id: membershipId }, permissions });
      const sponsor = (id, sponsorMembershipId = w.membershipId, historyAudience = [w.membershipId]) =>
        http('PUT', `${base}/${id}/sponsorship`, { sponsorMembershipId, historyAudience });
      const activation = (current, enabled) =>
        http('POST', `${base}/${current.id}/activation`, {
          commandId: randomUUID(),
          expectedGeneration: current.generation,
          revision: current.revision,
          enabled,
        });
      const runs = id => http('GET', `${base}/${id}/runs`).then(page => page.runs);
      const finish = async works => {
        for (const work of works) for (let step = 0; step < 4 && (await service.advance(work)).kind !== 'done'; step++);
      };
      const drain = async () => finish(await service.due(w.id));
      const read = async id => (await http('GET', base)).find(item => item.id === id);

      const invalidRange = await app.inject({
        method: 'PUT',
        url: `${base}/${randomUUID()}`,
        headers,
        payload: {
          revision: randomUUID(),
          expectedRevision: null,
          definition: definition('bad hour', { kind: 'cron', expression: '0 25 * * *', timezone: 'UTC' }),
        },
      });
      assert.equal(invalidRange.statusCode, 409);
      assert.deepEqual(invalidRange.json(), { error: 'invalid-schedule' });
      const invalidZone = await app.inject({
        method: 'PUT',
        url: `${base}/${randomUUID()}`,
        headers,
        payload: {
          revision: randomUUID(),
          expectedRevision: null,
          definition: definition('bad zone', { kind: 'cron', expression: '0 9 * * *', timezone: 'Not/AZone' }),
        },
      });
      assert.equal(invalidZone.statusCode, 409);
      assert.deepEqual(invalidZone.json(), { error: 'invalid-schedule' });
      assert.deepEqual(await http('GET', base), []);

      const cronId = randomUUID(),
        intervalId = randomUUID();
      let cron = await save(cronId, { kind: 'cron', expression: '*/5 * * * *', timezone: 'Asia/Kolkata' });
      let interval = await save(intervalId, { kind: 'interval', minutes: 60 });
      assert.equal(cron.nextRunAt, null);
      cron = await sponsor(cronId);
      interval = await sponsor(intervalId);
      cron = await activation(cron, true);
      interval = await activation(interval, true);
      assert.ok(minutesFromNow(cron.nextRunAt) > 0 && minutesFromNow(cron.nextRunAt) <= 5, cron.nextRunAt);
      assert.equal(new Date(cron.nextRunAt).getUTCMinutes() % 5, 0);
      assert.equal(new Date(cron.nextRunAt).getUTCSeconds(), 0);
      assert.ok(Math.abs(minutesFromNow(interval.nextRunAt) - 60) < 1, interval.nextRunAt);

      await drain();
      assert.deepEqual(await runs(cronId), []);
      assert.deepEqual(await runs(intervalId), []);

      const dueAt = async id =>
        new Date(
          (await db.databaseAdmin.query(`SELECT next_run_at FROM ${workflows} WHERE id=$1`, [id])).rows[0].next_run_at,
        ).toISOString();
      await elapse(cronId, '3 hours');
      await elapse(intervalId, '150 minutes');
      const cronDue = await dueAt(cronId),
        intervalDue = await dueAt(intervalId);
      await drain();
      await drain();
      const nextFiveMinutes = iso => new Date(Math.floor(Date.parse(iso) / 300000) * 300000 + 300000).toISOString();
      for (const [id, scheduledFor, missedCount, firstMissed] of [
        [cronId, cronDue, 36, nextFiveMinutes(cronDue)],
        [intervalId, intervalDue, 2, new Date(Date.parse(intervalDue) + 3600000).toISOString()],
      ]) {
        const history = await runs(id);
        assert.deepEqual(
          history.map(run => [run.source, run.status, run.error]),
          [
            ['schedule', 'skipped', 'missed-occurrences-coalesced'],
            ['schedule', 'completed', null],
          ],
          id,
        );
        assert.deepEqual(history[1].input, { scheduledFor }, 'a scheduled run receives its occurrence as input');
        assert.deepEqual(
          history[1].steps.map(step => [step.stepId, step.status, step.output]),
          [['copy', 'completed', { at: scheduledFor }]],
        );
        assert.deepEqual(history[0].steps, []);
        assert.equal(history[0].input.missedCount, missedCount, id);
        assert.equal(history[0].input.scheduledFor, firstMissed, id);
      }
      cron = await read(cronId);
      interval = await read(intervalId);
      assert.ok(minutesFromNow(cron.nextRunAt) > 0 && minutesFromNow(cron.nextRunAt) <= 5, cron.nextRunAt);
      assert.ok(Math.abs(minutesFromNow(interval.nextRunAt) - 60) < 1, interval.nextRunAt);

      await elapse(intervalId, '5 minutes');
      const overlapping = await service.due(w.id);
      assert.equal(overlapping.length, 1);
      assert.deepEqual(
        (await runs(intervalId)).map(run => [run.source, run.status]),
        [
          ['schedule', 'queued'],
          ['schedule', 'skipped'],
          ['schedule', 'completed'],
        ],
      );
      await elapse(intervalId, '1 minute');
      const suppressedDue = await dueAt(intervalId);
      await service.due(w.id);
      const suppressed = await runs(intervalId);
      assert.deepEqual(
        suppressed.map(run => [run.status, run.error]),
        [
          ['queued', null],
          ['skipped', 'previous-run-unfinished'],
          ['skipped', 'missed-occurrences-coalesced'],
          ['completed', null],
        ],
        'an unfinished scheduled run records the suppressed occurrence',
      );
      assert.deepEqual(suppressed[1].input, { scheduledFor: suppressedDue });
      assert.ok(
        Math.abs(minutesFromNow((await read(intervalId)).nextRunAt) - 60) < 1,
        'a skipped occurrence still advances next_run_at',
      );
      await finish(overlapping);
      assert.deepEqual(
        (await runs(intervalId)).map(run => run.status),
        ['skipped', 'completed', 'skipped', 'completed'],
      );
      await elapse(intervalId, '1 minute');
      await drain();
      assert.deepEqual(
        (await runs(intervalId)).map(run => run.status),
        ['completed', 'skipped', 'completed', 'skipped', 'completed'],
        'scheduling resumes after the previous run finishes',
      );

      const revokedId = randomUUID();
      let revoked = await save(revokedId, { kind: 'interval', minutes: 10 });
      await grant(revokedId, operator.membershipId);
      await sponsor(revokedId, operator.membershipId, [w.membershipId]);
      await service.acceptSponsorship(w.id, operator.id, revokedId, {
        expectedGeneration: (await read(revokedId)).generation,
      });
      revoked = await activation(await read(revokedId), true);
      assert.equal(revoked.sponsorMembershipId, operator.membershipId);
      await db.databaseAdmin.query(`UPDATE ${memberships} SET removed_at=clock_timestamp() WHERE id=$1`, [
        operator.membershipId,
      ]);
      await elapse(revokedId, '15 minutes');
      const revokedWork = await service.due(w.id);
      assert.equal(revokedWork.length, 1);
      await finish(revokedWork);
      assert.deepEqual(
        (await runs(revokedId)).map(run => [run.source, run.status, run.error]),
        [
          ['schedule', 'skipped', 'missed-occurrences-coalesced'],
          ['schedule', 'blocked', 'authority-revoked'],
        ],
      );
      assert.equal((await read(revokedId)).enabled, false, 'a removed sponsor stops the schedule');

      const manual = await http('POST', `${base}/${intervalId}/runs`, { requestId: randomUUID(), input: null });
      await elapse(intervalId, '1 minute');
      await service.due(w.id);
      const mixed = await runs(intervalId);
      assert.deepEqual(
        mixed
          .filter(run => run.status === 'queued')
          .map(run => run.source)
          .sort(),
        ['manual', 'schedule'],
        'manual runs do not suppress scheduled ones',
      );
      assert.ok(mixed.some(run => run.id === manual.runId));
      await drain();

      cron = await activation(cron, false);
      assert.equal(cron.enabled, false);
      await elapse(cronId);
      await drain();
      assert.equal((await runs(cronId)).length, 2, 'a disabled cron workflow does not fire');
      cron = await activation(cron, true);
      assert.ok(
        minutesFromNow(cron.nextRunAt) > 0 && minutesFromNow(cron.nextRunAt) <= 5,
        `re-enabling recomputes from now: ${cron.nextRunAt}`,
      );
      await drain();
      assert.equal((await runs(cronId)).length, 2, 're-enabling does not replay the time spent disabled');

      interval = await read(intervalId);
      const edited = await save(intervalId, { kind: 'interval', minutes: 5 }, interval.revision);
      assert.equal(edited.activeRevision, interval.revision);
      assert.ok(Math.abs(minutesFromNow(edited.nextRunAt) - 60) < 1, 'saving alone keeps the active schedule');
      interval = await activation(await sponsor(intervalId), true);
      assert.equal(interval.activeRevision, edited.revision);
      assert.ok(
        Math.abs(minutesFromNow(interval.nextRunAt) - 5) < 1,
        `reactivation recomputes from the new interval: ${interval.nextRunAt}`,
      );
      await elapse(intervalId, '1 minute');
      await drain();
      const latest = (await runs(intervalId))[0];
      assert.deepEqual([latest.source, latest.status, latest.revision], ['schedule', 'completed', edited.revision]);
      assert.ok(Math.abs(minutesFromNow((await read(intervalId)).nextRunAt) - 5) < 1);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
