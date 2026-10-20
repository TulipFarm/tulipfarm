import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { maxWaitSeconds } from '../src/contracts.ts';
import { activate } from './commands.fixture.mjs';

const hour = 3600000,
  minute = 60000;

test('schedule timing follows the database clock when the API host clock is skewed', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
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
    const service = createWorkflows(runtime);
    const databaseNow = async () => (await db.platform.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    const skewHost = async offset => {
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['Date'], now: (await databaseNow()) + offset });
    };
    const definition = trigger => ({
      version: 1,
      name: 'Clock check',
      trigger,
      steps: [{ id: 'done', kind: 'transform', fields: { done: { kind: 'literal', value: true } } }],
    });
    const nextRunAt = async id =>
      Date.parse((await service.list(w.id, w.userId)).find(item => item.id === id).nextRunAt);
    const scheduledRuns = async id =>
      (await service.history(w.id, w.userId, id).then(page => page.runs)).filter(
        run => run.source === 'schedule' && run.status !== 'skipped',
      );
    const reminder = randomUUID(),
      reminderRevision = randomUUID();
    await service.save(w.id, w.userId, reminder, {
      revision: reminderRevision,
      expectedRevision: null,
      definition: {
        version: 1,
        name: 'Reminder',
        trigger: { kind: 'manual' },
        steps: [{ id: 'start', kind: 'wait-until', at: { kind: 'input', path: ['start'] } }],
      },
    });
    await activate(service, w.id, w.userId, reminder, reminderRevision, true);
    const waitUntil = async offset => {
      const { runId } = await service.start(w.id, w.userId, reminder, {
        requestId: randomUUID(),
        input: { start: new Date((await databaseNow()) + maxWaitSeconds * 1000 + offset).toISOString() },
      });
      await service.advance({ workspaceId: w.id, runId });
      const run = (await service.history(w.id, w.userId, reminder).then(page => page.runs)).find(
        item => item.id === runId,
      );
      return [run.status, run.error];
    };

    await skewHost(-2 * hour);
    const hourly = randomUUID(),
      hourlyRevision = randomUUID();
    await service.save(w.id, w.userId, hourly, {
      revision: hourlyRevision,
      expectedRevision: null,
      definition: definition({ kind: 'interval', minutes: 60 }),
    });
    await service.sponsorship(w.id, w.userId, hourly, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    const activatedAt = await databaseNow();
    await activate(service, w.id, w.userId, hourly, hourlyRevision, true);
    const firstRun = await nextRunAt(hourly);
    assert.ok(
      firstRun >= activatedAt + 59 * minute && firstRun <= activatedAt + 61 * minute,
      `activation schedules one interval after the database time, got ${new Date(firstRun).toISOString()}`,
    );
    await service.due(w.id);
    assert.deepEqual(
      await scheduledRuns(hourly),
      [],
      'a host clock behind the database does not make the schedule fire early',
    );

    await db.databaseAdmin.query(
      `UPDATE "${w.names.schema}".tf_workflows SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [hourly],
    );
    const sweptAt = await databaseNow();
    await service.due(w.id);
    await service.due(w.id);
    assert.equal((await scheduledRuns(hourly)).length, 1, 'the due occurrence runs exactly once');
    const advanced = await nextRunAt(hourly);
    assert.ok(
      advanced >= sweptAt + 59 * minute && advanced <= sweptAt + 61 * minute,
      `the sweep advances one interval after the database time, got ${new Date(advanced).toISOString()}`,
    );

    assert.deepEqual(
      await waitUntil(-hour),
      ['waiting', null],
      'a wait within the limit by database time is accepted when the host clock is behind',
    );

    const past = randomUUID();
    await assert.rejects(
      service.save(w.id, w.userId, past, {
        revision: randomUUID(),
        expectedRevision: null,
        definition: definition({ kind: 'once', at: new Date((await databaseNow()) - hour).toISOString() }),
      }),
      { message: 'schedule-in-past' },
      'a time the database has passed is rejected even when the host clock is behind',
    );

    await skewHost(2 * hour);
    const later = randomUUID(),
      laterRevision = randomUUID(),
      at = new Date((await databaseNow()) + hour).toISOString();
    await service.save(w.id, w.userId, later, {
      revision: laterRevision,
      expectedRevision: null,
      definition: definition({ kind: 'once', at }),
    });
    await service.sponsorship(w.id, w.userId, later, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    await activate(service, w.id, w.userId, later, laterRevision, true);
    assert.equal(
      new Date(await nextRunAt(later)).toISOString(),
      at,
      'a time still ahead of the database is accepted even when the host clock is ahead',
    );
    await service.due(w.id);
    assert.deepEqual(await scheduledRuns(later), [], 'the one-time schedule waits for the database clock');
    assert.deepEqual(
      await waitUntil(hour),
      ['failed', 'wait-until-too-far'],
      'a wait beyond the limit by database time is rejected when the host clock is ahead',
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
