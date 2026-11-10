import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '../../workspace-storage/src/provisioning.ts';
import { lockAuthorization } from '../src/index.ts';

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
    // Holds a shared authorization lock until the returned release is called.
    async share() {
      let release;
      let held;
      const locked = new Promise(resolve => (held = resolve));
      const done = inTransaction(holder, async client => {
        await lockAuthorization({ client, schema });
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
        await lockAuthorization({ client, schema: locks.schema });
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
    setTimeout(() => void release(), 150);
    const kept = await inTransaction(locks.waiter, async client => {
      await client.query(`SET LOCAL lock_timeout = '100ms'`);
      await client.query(`SELECT set_config('tf.earlier_work', 'kept', true)`);
      await lockAuthorization({ client, schema: locks.schema }, 'write');
      return (await client.query(`SELECT current_setting('tf.earlier_work') AS value`)).rows[0].value;
    });
    assert.equal(kept, 'kept');

    release = await locks.share();
    try {
      await assert.rejects(
        inTransaction(locks.waiter, async client => {
          await client.query(`SET LOCAL lock_timeout = '50ms'`);
          await lockAuthorization({ client, schema: locks.schema }, 'write');
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
