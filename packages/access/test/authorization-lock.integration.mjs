import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '../../workspace-storage/src/provisioning.ts';
import { closeTransactionMemos, openTransactionMemos } from '@tulipfarm/workspace-storage/transaction-reads';
import {
  forgetMembers,
  lockAndPrefetchHuman,
  lockAndResolveHuman,
  lockAuthorization,
  resolveHuman,
  WorkspaceMembershipDenied,
} from '../src/index.ts';

// Counts lock acquisitions by mode and outcome, and retried waits, from the metrics the lock records.
function captureLockMetrics(t) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
  metrics.disable();
  assert.ok(metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] })));
  t.after(() => metrics.disable());
  return async name => {
    await reader.forceFlush();
    return exporter
      .getMetrics()
      .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
      .filter(metric => metric.descriptor.name === name)
      .flatMap(metric => metric.dataPoints)
      .map(point => [point.attributes.mode, point.attributes.outcome, point.value]);
  };
}

async function lockFixture() {
  const setup = await fixture();
  const workspace = await setup.create();
  const holder = await connect(setup.login(workspace));
  const waiter = await connect(setup.login(workspace));
  const reader = await connect(setup.login(workspace));
  const schema = workspace.names.schema;
  return {
    schema,
    holder,
    waiter,
    reader,
    // Holds the authorization lock in `mode` until the returned release is called.
    async share(mode = 'read') {
      let release;
      let held;
      const locked = new Promise(resolve => (held = resolve));
      const done = inTransaction(holder, async client => {
        await lockAuthorization({ client, schema }, mode);
        held();
        await new Promise(resolve => (release = resolve));
      });
      await Promise.race([locked, done]);
      return async () => {
        release();
        await done;
      };
    },
    async close() {
      await Promise.all([holder.end(), waiter.end(), reader.end()]);
      await setup.close();
    },
  };
}

test('shared authorization locks do not wait for each other', async () => {
  const locks = await lockFixture();
  try {
    const release = await locks.share();
    const started = Date.now();
    await inTransaction(locks.waiter, async client => {
      await client.query(`SET LOCAL lock_timeout = '200ms'`);
      await lockAuthorization({ client, schema: locks.schema });
    });
    assert.ok(Date.now() - started < 200);
    await release();
  } finally {
    await locks.close();
  }
});

test('a waiting write is not overtaken by reads that arrive after it', async () => {
  const locks = await lockFixture();
  try {
    const release = await locks.share();
    const write = inTransaction(locks.waiter, async client => {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await lockAuthorization({ client, schema: locks.schema }, 'write', { retry: false });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(
      inTransaction(locks.reader, async client => {
        await client.query(`SET LOCAL lock_timeout = '200ms'`);
        await lockAuthorization({ client, schema: locks.schema }, 'read', { retry: false });
      }),
      { code: '55P03' },
    );
    // Trying the lock without waiting must not let a read past the queued write either.
    await assert.rejects(
      inTransaction(locks.reader, async client => {
        await client.query(`SET LOCAL lock_timeout = '50ms'`);
        await lockAuthorization({ client, schema: locks.schema }, 'read', { budgetMs: 200 });
      }),
      { code: '55P03' },
    );
    await release();
    await write;
  } finally {
    await locks.close();
  }
});

test('a write that times out waiting for the lock tries again without losing its earlier work', async () => {
  const locks = await lockFixture();
  try {
    let release = await locks.share();
    const kept = await inTransaction(locks.waiter, async client => {
      await client.query(`SET LOCAL lock_timeout = '100ms'`);
      await client.query(`SELECT set_config('tf.earlier_work', 'kept', true)`);
      await lockAuthorization(
        {
          client: {
            query: async (...args) => {
              const result = await client.query(...args);
              if (args[0] === 'ROLLBACK TO SAVEPOINT tf_authorization_lock') await release();
              return result;
            },
          },
          schema: locks.schema,
        },
        'write',
      );
      assert.equal(
        (
          await client.query(
            `INSERT INTO "${locks.schema}".tf_teams(id,name) VALUES(gen_random_uuid(),'Lock retry probe')
           RETURNING xmin=pg_current_xact_id()::xid AS top_level`,
          )
        ).rows[0].top_level,
        true,
        'Work after a lock retry must not remain inside a leaked savepoint',
      );
      return (await client.query(`SELECT current_setting('tf.earlier_work') AS value`)).rows[0].value;
    });
    assert.equal(kept, 'kept');

    release = await locks.share();
    try {
      await assert.rejects(
        inTransaction(locks.waiter, async client => {
          await client.query(`SET LOCAL lock_timeout = '50ms'`);
          await lockAuthorization({ client, schema: locks.schema }, 'write', { budgetMs: 300 });
        }),
        { code: '55P03' },
      );
      await assert.rejects(
        inTransaction(locks.waiter, async client => {
          await client.query(`SET LOCAL lock_timeout = '50ms'`);
          await lockAuthorization({ client, schema: locks.schema }, 'write', { retry: false });
        }),
        { code: '55P03' },
      );
    } finally {
      await release();
    }
  } finally {
    await locks.close();
  }
});

test('a read that times out waiting behind a write tries again and reads once the write commits', async t => {
  const lockMetrics = captureLockMetrics(t);
  const locks = await lockFixture();
  try {
    const release = await locks.share('write');
    setTimeout(release, 400);
    const started = Date.now();
    const read = await inTransaction(locks.reader, async client => {
      await client.query(`SET LOCAL lock_timeout = '100ms'`);
      await client.query(`SELECT set_config('tf.earlier_work', 'kept', true)`);
      await lockAuthorization({ client, schema: locks.schema });
      return (await client.query(`SELECT current_setting('tf.earlier_work') AS value`)).rows[0].value;
    });
    assert.equal(read, 'kept');
    assert.ok(Date.now() - started >= 300, 'The read waited for the write to commit');
    const acquisitions = await lockMetrics('cloud_authorization_lock_acquisitions');
    assert.deepEqual(
      acquisitions.filter(([, outcome]) => outcome !== 'acquired'),
      [['read', 'retried', 1]],
    );
    const [[, , retries]] = await lockMetrics('cloud_authorization_lock_retries');
    assert.ok(retries >= 1);
  } finally {
    await locks.close();
  }
});

test('a read still waiting when its retry budget runs out fails and is counted as failed', async t => {
  const lockMetrics = captureLockMetrics(t);
  const locks = await lockFixture();
  try {
    const release = await locks.share('write');
    try {
      const started = Date.now();
      await assert.rejects(
        inTransaction(locks.reader, async client => {
          await client.query(`SET LOCAL lock_timeout = '50ms'`);
          await lockAuthorization({ client, schema: locks.schema }, 'read', { budgetMs: 300 });
        }),
        { code: '55P03' },
      );
      assert.ok(Date.now() - started < 2_000, 'The retry budget bounds the wait');
    } finally {
      await release();
    }
    const acquisitions = await lockMetrics('cloud_authorization_lock_acquisitions');
    assert.deepEqual(
      acquisitions.filter(([, outcome]) => outcome !== 'acquired'),
      [['read', 'failed', 1]],
    );
  } finally {
    await locks.close();
  }
});

test('a member read with the lock is reused until this transaction changes memberships', async () => {
  const setup = await fixture();
  const workspace = await setup.create();
  const connection = await connect(setup.login(workspace));
  try {
    await inTransaction(connection, async client => {
      const memos = openTransactionMemos(client);
      const tx = { client, schema: workspace.names.schema };
      try {
        await lockAndPrefetchHuman(tx, 'not-a-member');
        await lockAndPrefetchHuman(tx, workspace.userId);
        let queries = 0;
        const query = client.query;
        client.query = (...args) => (queries++, query.apply(client, args));
        assert.deepEqual(await resolveHuman(tx, workspace.userId), {
          kind: 'human',
          userId: workspace.userId,
          membershipId: workspace.membershipId,
        });
        assert.equal(queries, 0);
        await assert.rejects(resolveHuman(tx, 'not-a-member'), WorkspaceMembershipDenied);
        await client.query(`UPDATE ${workspace.names.schema}.tf_memberships SET removed_at = now() WHERE id = $1`, [
          workspace.membershipId,
        ]);
        forgetMembers(tx);
        await assert.rejects(resolveHuman(tx, workspace.userId), WorkspaceMembershipDenied);
      } finally {
        closeTransactionMemos(client, memos);
      }
    });
  } finally {
    await connection.end();
    await setup.close();
  }
});

test('a sibling query still waiting when the read lock and member read settle gets its own reply', async () => {
  const setup = await fixture();
  const workspace = await setup.create();
  const connection = await connect(setup.login(workspace));
  const failures = [];
  connection.on('error', error => failures.push(error));
  try {
    await inTransaction(connection, async client => {
      const tx = { client, schema: workspace.names.schema };
      const who = result => result.rows[0]?.who;
      // Like integrations.list: one connection lookup takes the lock and resolves the member while sibling lookups on
      // the same transaction send queries behind them, then the first lookup goes on to its next query before the
      // siblings' replies are in.
      const actor = lockAndResolveHuman(tx, workspace.userId);
      const siblings = [client.query("SELECT 'slow' AS who, pg_sleep(0.05)"), client.query("SELECT 'fast' AS who")];
      assert.deepEqual(await actor, { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId });
      const next = client.query("SELECT 'next' AS who");
      assert.deepEqual((await Promise.all(siblings)).map(who), ['slow', 'fast']);
      assert.equal(who(await next), 'next');
      assert.equal(client.pipeline, false);
    });
    assert.deepEqual(failures, []);
  } finally {
    await connection.end().catch(() => {});
    await setup.close();
  }
});
