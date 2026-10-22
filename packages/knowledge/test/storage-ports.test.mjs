import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { knowledgeTenantRuntime, transactionRepository, knowledgeStorageErrors } from '../dist/storage-ports.js';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';

test('tenant runtime retains host receiver, exact context, compatibility, deadline, result and rejection', async () => {
  const tenant = randomUUID();
  const context = { tenant };
  const answer = {};
  const failure = new Error('rollback');
  const host = {
    async transaction(id, options, operation) {
      assert.equal(this, host);
      assert.equal(id, tenant);
      assert.deepEqual(options, { ...commonCompatibility, deadlineAt: 1234 });
      return operation(context);
    },
  };
  const runtime = knowledgeTenantRuntime(host);
  assert.equal(
    await runtime.transaction(tenant, { deadlineAt: 1234 }, async value => {
      assert.equal(value, context);
      return answer;
    }),
    answer,
  );
  await assert.rejects(
    runtime.transaction(tenant, { deadlineAt: 1234 }, async () => {
      throw failure;
    }),
    error => error === failure,
  );
});

test('repository caching is scoped to transactions, not connections reused across tenants', () => {
  const client = {};
  const first = { client, schema: 'tenant_one' };
  const second = { client, schema: 'tenant_two' };
  let created = 0;
  const repository = transactionRepository(tx => {
    created++;
    return { schema: tx.schema };
  });
  assert.equal(repository(first), repository(first));
  assert.equal(repository(second), repository(second));
  assert.notEqual(repository(first), repository(second));
  assert.equal(repository(first).schema, 'tenant_one');
  assert.equal(repository(second).schema, 'tenant_two');
  assert.equal(created, 2);
});

test('host storage classification retains exact timeout and transient code behavior', () => {
  const timeout = knowledgeStorageErrors.timeout();
  assert.ok(timeout instanceof StorageUnavailableError);
  assert.equal(timeout.code, 'wait_timeout');
  for (const code of ['wait_timeout', 'queue_full', 'pool_capacity', 'stale_credential', 'closed']) {
    const error = new StorageUnavailableError(code);
    assert.equal(
      knowledgeStorageErrors.deadline(error),
      ['wait_timeout', 'queue_full', 'pool_capacity'].includes(code),
    );
    assert.equal(knowledgeStorageErrors.transient(error), code !== 'closed');
  }
  for (const code of [
    '40001',
    '40P01',
    '55P03',
    '57014',
    '08000',
    '08001',
    '08003',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
  ]) {
    assert.equal(knowledgeStorageErrors.transient({ code }), true, code);
    const error = Object.assign(new Error(code), { code });
    assert.equal(knowledgeStorageErrors.deadline(error), ['55P03', '57014'].includes(code), code);
  }
  for (const error of [null, undefined, '57014', { code: 57014 }, { code: '23505' }, new Error('unknown')])
    assert.equal(knowledgeStorageErrors.transient(error), false);
  assert.equal(knowledgeStorageErrors.deadline({ code: '57014' }), false);
});
