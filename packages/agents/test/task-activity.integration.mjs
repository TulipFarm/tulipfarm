import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lockAuthorization } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { activeTaskWork, reserveTaskWork, withTaskWork } from '../src/task-activity.ts';
import { lockTask } from '../src/task-approval-gate.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('active-work lifetime owns clocks and cleanup across caller transactions', { timeout: 30000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  const table = name => `"${w.names.schema}"."${name}"`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member);
  const tasks = createAgentTasks(runtime);
  const start = () =>
    tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text: 'Account for active work.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    });
  const locked = (taskId, operation) =>
    runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await lockTask(tx, taskId);
      return operation(tx);
    });
  const entries = async taskId =>
    (
      await db.platform.query(
        `SELECT status,reserved_milliseconds::text,settled_milliseconds::text FROM ${table('tf_agent_task_activity')} WHERE task_id=$1`,
        [taskId],
      )
    ).rows;
  const charged = async taskId =>
    (await db.platform.query(`SELECT active_milliseconds::text FROM ${table('tf_agent_tasks')} WHERE id=$1`, [taskId]))
      .rows[0].active_milliseconds;
  let now = 100;
  t.mock.method(performance, 'now', () => now);

  await t.test('files settle before continuation and final cleanup cannot charge twice', async () => {
    const task = await start(),
      transact = operation => locked(task.id, operation);
    const reservation = await transact(tx => reserveTaskWork(tx, task.id, 'files'));
    let cleanups = 0;
    await withTaskWork(
      operation => {
        cleanups++;
        return transact(operation);
      },
      async work => {
        await work.admit(reservation);
        assert.equal(work.reserved, true);
        assert.equal(await charged(task.id), '60000');
        assert.equal(await transact(tx => work.live(tx, task.id)), true);
        assert.equal(await transact(tx => work.live(tx, randomUUID())), false);
        assert.equal(
          await transact(tx => activeTaskWork(tx, task.id)),
          true,
          'another task-lock transaction completes while file work is active',
        );
        assert.equal(await transact(tx => reserveTaskWork(tx, task.id, 'tool')), null);
        now += 23.2;
        assert.equal(work.withinAllowance(), true);
        assert.equal(await transact(tx => work.complete(tx)), true);
        assert.equal(await charged(task.id), '24', 'continuation observes settled file time');
        assert.equal(await transact(tx => work.live(tx)), false);
        now += 100;
      },
    );
    assert.equal(cleanups, 1);
    assert.deepEqual(await entries(task.id), [
      { status: 'settled', reserved_milliseconds: '60000', settled_milliseconds: '24' },
    ]);
    assert.equal(await charged(task.id), '24');
  });

  await t.test('rolled-back admission never starts or finalizes a reservation', async () => {
    const task = await start();
    let cleanups = 0;
    await assert.rejects(
      withTaskWork(
        async () => {
          cleanups++;
        },
        async work => {
          await work.admit(() =>
            locked(task.id, async tx => {
              await reserveTaskWork(tx, task.id, 'tool');
              throw new Error('admission rollback');
            }),
          );
        },
      ),
      /admission rollback/,
    );
    assert.equal(cleanups, 0);
    assert.equal(await charged(task.id), '0');
    assert.deepEqual(await entries(task.id), []);
  });

  await t.test('failed work and rolled-back early settlement still get final cleanup', async () => {
    for (const kind of ['files', 'tool']) {
      const task = await start(),
        transact = operation => locked(task.id, operation);
      await assert.rejects(
        withTaskWork(transact, async work => {
          assert.equal(await work.admit(() => transact(tx => reserveTaskWork(tx, task.id, kind))), true);
          now += 15;
          await assert.rejects(
            transact(async tx => {
              await work.complete(tx);
              throw new Error('continuation rollback');
            }),
            /continuation rollback/,
          );
          assert.equal((await entries(task.id))[0].status, 'running');
          now += 5;
          throw new Error('work failed');
        }),
        /work failed/,
      );
      assert.equal(await charged(task.id), '20');
      assert.equal((await entries(task.id))[0].status, 'settled');
    }
  });

  await t.test('elapsed allowance and database expiry fence continuation without losing crash charge', async () => {
    const task = await start(),
      transact = operation => locked(task.id, operation);
    await withTaskWork(transact, async work => {
      await work.admit(() => transact(tx => reserveTaskWork(tx, task.id, 'files')));
      now += 60000;
      assert.equal(work.withinAllowance(), false);
      await db.platform.query(
        `UPDATE ${table('tf_agent_task_activity')} SET expires_at=clock_timestamp()-interval '1 second' WHERE task_id=$1`,
        [task.id],
      );
      assert.equal(await transact(tx => work.live(tx)), false);
      await Promise.all([transact(tx => activeTaskWork(tx, task.id)), transact(tx => activeTaskWork(tx, task.id))]);
      assert.equal(await transact(tx => work.complete(tx)), false);
    });
    assert.deepEqual(await entries(task.id), [
      { status: 'abandoned', reserved_milliseconds: '60000', settled_milliseconds: null },
    ]);
    assert.equal(await charged(task.id), '60000');
  });

  await t.test('two borrowed external workers leave cleanup to the batch even after partial failure', async () => {
    const task = await start(),
      transact = operation => locked(task.id, operation);
    let childCleanups = 0;
    await assert.rejects(
      withTaskWork(transact, async batch => {
        await batch.admit(() => transact(tx => reserveTaskWork(tx, task.id, 'tool')));
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        let active = 0,
          maximum = 0;
        const child = fail =>
          withTaskWork(
            async () => {
              childCleanups++;
            },
            async work => {
              await work.admit(batch);
              active++;
              maximum = Math.max(maximum, active);
              if (active === 2) entered.resolve();
              await release.promise;
              assert.equal(await transact(tx => work.live(tx, task.id)), true);
              active--;
              if (fail) throw new Error('one worker failed');
              return 'completed';
            },
          );
        const outcomes = Promise.allSettled([child(true), child(false)]);
        await entered.promise;
        assert.equal(maximum, 2);
        now += 90;
        release.resolve();
        const settled = await outcomes;
        assert.equal(settled[0].status, 'rejected');
        assert.equal(settled[1].value, 'completed');
        assert.equal((await entries(task.id))[0].status, 'running');
        throw settled[0].reason;
      }),
      /one worker failed/,
    );
    assert.equal(childCleanups, 0);
    assert.equal(await charged(task.id), '90', 'shared wall time is charged once, not summed');
  });

  await t.test('synchronous borrowed calls retain early per-call settlement and fence later calls', async () => {
    const task = await start(),
      transact = operation => locked(task.id, operation);
    let childCleanups = 0;
    await withTaskWork(transact, async batch => {
      await batch.admit(() => transact(tx => reserveTaskWork(tx, task.id, 'tool')));
      now += 20;
      await withTaskWork(
        async () => {
          childCleanups++;
        },
        async work => {
          await work.admit(batch);
          now += 7;
          assert.equal(await transact(tx => work.settle(tx)), true);
        },
      );
      assert.equal(await charged(task.id), '7', 'current synchronous behavior uses the child clock');
      assert.equal(await transact(tx => batch.live(tx)), false);
      now += 100;
    });
    assert.equal(childCleanups, 0);
    assert.equal(await charged(task.id), '7', 'batch cleanup does not replace an early settlement');
  });

  await t.test('legacy and refused admission create no cleanup transaction; cleanup failures propagate', async () => {
    for (const admission of ['legacy', null]) {
      let cleanups = 0;
      await withTaskWork(
        async () => {
          cleanups++;
        },
        async work => {
          assert.equal(await work.admit(admission), admission === 'legacy');
          assert.equal(work.reserved, false);
        },
      );
      assert.equal(cleanups, 0);
    }
    const task = await start();
    await assert.rejects(
      withTaskWork(
        async () => {
          throw new Error('cleanup failed');
        },
        async work => {
          await work.admit(() => locked(task.id, tx => reserveTaskWork(tx, task.id, 'tool')));
          throw new Error('original work failure');
        },
      ),
      /cleanup failed/,
    );
    assert.equal((await entries(task.id))[0].status, 'running');
    assert.equal(await charged(task.id), '60000');
  });
});
