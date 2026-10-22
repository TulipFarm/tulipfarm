import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test(
  'run history pages finished runs by cursor, keeps unfinished runs on the first page, and filters by status',
  { timeout: 120000 },
  async () => {
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
      const table = name => qualified(w.names.schema, name);
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Copy input',
          trigger: { kind: 'manual' },
          steps: [{ id: 'copy', kind: 'transform', fields: { n: { kind: 'input', path: ['n'] } } }],
        },
      });
      await activate(service, w.id, w.userId, id, revision, true);
      const start = async n =>
        (await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { n } })).runId;
      const completed = [];
      for (let n = 0; n < 52; n++) {
        const runId = await start(n);
        while ((await service.advance({ workspaceId: w.id, runId })).kind !== 'done');
        completed.unshift(runId);
      }
      const cancelled = await start(52);
      await service.cancel(w.id, w.userId, id, cancelled);
      const unfinished = await start(53);
      await db.platform.query(
        `UPDATE ${table('tf_workflow_runs')} SET created_at=created_at-interval '1 day' WHERE id=$1`,
        [unfinished],
      );
      const finished = [cancelled, ...completed];

      const first = await service.history(w.id, w.userId, id);
      assert.deepEqual(
        first.runs.map(run => run.id),
        [unfinished, ...finished.slice(0, 50)],
        'the first page lists the old unfinished run, then the 50 newest finished runs',
      );
      assert.notEqual(first.nextCursor, null);
      const second = await service.history(w.id, w.userId, id, { before: first.nextCursor });
      assert.deepEqual(
        second.runs.map(run => run.id),
        finished.slice(50),
        'the next page continues after the last finished run without repeating the unfinished one',
      );
      assert.equal(second.nextCursor, null);
      assert.deepEqual(
        second.runs.map(run => [run.status, run.input, run.steps.map(step => step.output)]),
        [
          ['completed', { n: 2 }, [{ n: 2 }]],
          ['completed', { n: 1 }, [{ n: 1 }]],
          ['completed', { n: 0 }, [{ n: 0 }]],
        ],
      );

      assert.deepEqual(await service.history(w.id, w.userId, id, { status: 'cancelled' }), {
        runs: [first.runs[1]],
        nextCursor: null,
      });
      assert.deepEqual(
        (await service.history(w.id, w.userId, id, { status: 'queued' })).runs.map(run => run.id),
        [unfinished],
      );
      assert.deepEqual(await service.history(w.id, w.userId, id, { status: 'failed' }), { runs: [], nextCursor: null });
      const completedFirst = await service.history(w.id, w.userId, id, { status: 'completed' });
      assert.deepEqual(
        completedFirst.runs.map(run => run.id),
        completed.slice(0, 50),
      );
      assert.deepEqual(
        (
          await service.history(w.id, w.userId, id, { status: 'completed', before: completedFirst.nextCursor })
        ).runs.map(run => run.id),
        completed.slice(50),
      );

      const skipped = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,status,error) VALUES ($1,$2,$3,$4,$5,$6,'skipped','missed-occurrences-coalesced')`,
        [skipped, id, revision, `schedule:${skipped}`, w.membershipId, JSON.stringify({})],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_run_audience')} (run_id,membership_id) VALUES ($1,$2)`,
        [skipped, w.membershipId],
      );
      assert.equal(
        (await service.history(w.id, w.userId, id)).runs.some(run => run.id === skipped),
        false,
        'skipped occurrences stay out of the default history so they do not displace completed or failed runs',
      );
      assert.deepEqual(
        (await service.history(w.id, w.userId, id, { status: 'skipped' })).runs.map(run => run.id),
        [skipped],
        'the skipped filter keeps skipped occurrences reviewable',
      );

      await assert.rejects(service.history(w.id, w.userId, id, { before: 'not-a-cursor' }), ZodError);
      await assert.rejects(service.history(w.id, w.userId, id, { status: 'unknown' }), ZodError);
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
