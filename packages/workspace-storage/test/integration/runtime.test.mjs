import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { escapeIdentifier, escapeLiteral } from 'pg';
import { createWorkspaceRuntime } from '../../src/runtime.ts';
import { qualified } from '../../src/provisioning.ts';
import { fixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test(
  'bounded direct-login routing isolates workspaces, rotates generations, resets sessions and drains shutdown',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const routers = [];
    try {
      const a = await db.create();
      const b = await db.create();
      const generation = new Map([
        [a.id, 1],
        [b.id, 1],
      ]);
      const settings = {
        maxPools: 2,
        connectionsPerPool: 1,
        maxConcurrentTransactions: 2,
        maxQueue: 1,
        waitTimeoutMs: 60,
        connectionTimeoutMs: 500,
        idleTimeoutMs: 100,
        replicaCount: 2,
        reservedConnections: 4,
        databaseConnectionBudget: 8,
      };
      const resolveCredential = async id => ({
        workspaceId: id,
        generation: generation.get(id),
        connectionString: db.login(id === a.id ? a : b),
      });
      const router = createWorkspaceRuntime({ ...settings, resolveCredential });
      routers.push(router);
      const compatibility = commonCompatibility;
      const read = id =>
        router.transaction(id, compatibility, async ({ client, schema }) => {
          const rows = await client.query(`SELECT user_id FROM ${qualified(schema, 'tf_memberships')}`);
          return rows.rows[0].user_id;
        });
      assert.deepEqual(await Promise.all([read(a.id), read(b.id)]), [a.userId, b.userId]);
      await router.transaction(a.id, compatibility, async ({ client }) => {
        await client.query("SET application_name = 'poisoned'");
      });
      assert.notEqual(
        await router.transaction(
          a.id,
          compatibility,
          async ({ client }) => (await client.query('SHOW application_name')).rows[0].application_name,
        ),
        'poisoned',
      );
      let called = false;
      await assert.rejects(
        router.transaction(a.id, { minimum: 1000, maximum: 1100 }, async () => {
          called = true;
        }),
        error => error.code === 'incompatible_version',
      );
      assert.equal(called, false);
      const oldPid = await router.transaction(
        a.id,
        compatibility,
        async ({ client }) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      );
      generation.set(a.id, 2);
      a.passwords.runtime = randomBytes(32).toString('hex');
      await db.platform.query(
        `ALTER ROLE ${escapeIdentifier(a.names.runtime)} PASSWORD ${escapeLiteral(a.passwords.runtime)}`,
      );
      const newPid = await router.transaction(
        a.id,
        compatibility,
        async ({ client }) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      );
      assert.notEqual(newPid, oldPid);
      generation.set(a.id, 1);
      await assert.rejects(read(a.id), error => error.code === 'stale_credential');
      generation.set(a.id, 2);
      const waits = [a.id, b.id].map(id =>
        router.transaction(id, compatibility, async ({ client }) => {
          await client.query('SELECT pg_sleep(0.2)');
        }),
      );
      const queued = read(a.id);
      const timeoutAssertion = assert.rejects(queued, error => error.code === 'wait_timeout');
      await assert.rejects(read(b.id), error => error.code === 'queue_full');
      await timeoutAssertion;
      await Promise.all(waits);
      assert.ok(router.stats().connections <= 2);
      await delay(250);
      assert.equal(router.stats().pools, 0);
      const bad = createWorkspaceRuntime({
        ...settings,
        resolveCredential: async () => ({ workspaceId: a.id, generation: 1, connectionString: db.login(b) }),
      });
      routers.push(bad);
      await assert.rejects(
        bad.transaction(a.id, compatibility, async () => undefined),
        /does not match/,
      );
      const constrained = createWorkspaceRuntime({ ...settings, maxPools: 1, resolveCredential });
      routers.push(constrained);
      let unlockPool;
      const poolGate = new Promise(resolve => {
        unlockPool = resolve;
      });
      let poolEntered;
      const poolStarted = new Promise(resolve => {
        poolEntered = resolve;
      });
      const oldGeneration = constrained.transaction(a.id, compatibility, async ({ client }) => {
        poolEntered();
        await poolGate;
        return (await client.query('SELECT current_user')).rows[0].current_user;
      });
      await poolStarted;
      generation.set(a.id, 3);
      await assert.rejects(
        constrained.transaction(a.id, compatibility, async () => undefined),
        error => error.code === 'pool_capacity',
      );
      await assert.rejects(
        constrained.transaction(b.id, compatibility, async () => undefined),
        error => error.code === 'pool_capacity',
      );
      unlockPool();
      assert.equal(await oldGeneration, a.names.runtime);
      assert.equal(
        await constrained.transaction(
          a.id,
          compatibility,
          async ({ client }) => (await client.query('SELECT current_user')).rows[0].current_user,
        ),
        a.names.runtime,
      );
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      let entered;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const inFlight = router.transaction(a.id, compatibility, async () => {
        entered();
        await gate;
        return 'completed';
      });
      await started;
      const shutdown = router.close();
      await assert.rejects(read(a.id), error => error.code === 'closed');
      release();
      assert.equal(await inFlight, 'completed');
      await shutdown;
      assert.equal(router.stats().connections, 0);
    } finally {
      await Promise.all(routers.map(router => router.close()));
      await db.close();
    }
  },
);
