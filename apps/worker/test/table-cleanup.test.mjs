import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableCleanupMaintenance } from '../src/table-cleanup.ts';
import { errorAttributes } from '@tulipfarm/observability';

test('table cleanup preserves each failure while continuing its bounded sweep', async () => {
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const failures = ids.map(() => Object.assign(new Error('private database details'), { code: '42501' }));
  const attempts = [];
  const registry = {
    query: async (_sql, values) => {
      assert.deepEqual(values, [null]);
      return { rows: ids.map(workspace_id => ({ workspace_id })) };
    },
  };
  const cleanup = createTableCleanupMaintenance(registry, async id => {
    attempts.push(id);
    throw failures[ids.indexOf(id)];
  });
  await assert.rejects(cleanup.sweep(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], failures[0]);
    assert.equal(error.errors[1], failures[1]);
    const { 'error.origin': origin, ...attributes } = errorAttributes(error);
    assert.match(origin, /^worker\/table-cleanup\.ts:\d+$/);
    assert.deepEqual(attributes, {
      'error.type': 'Error',
      'error.stage': 'table-cleanup-credentials',
      'error.code': '42501',
      'error.reason': 'Database permission denied',
    });
    return true;
  });
  assert.deepEqual(attempts, ids);
  await assert.rejects(cleanup.sweep(), AggregateError);
  assert.deepEqual(attempts, [...ids, ...ids]);
  await assert.rejects(cleanup.cleanupTableHistory(ids[0]), error => {
    assert.equal(error.message, 'table-cleanup-retry');
    assert.equal(error.cause, undefined, 'Temporal failure history must not retain raw database details');
    return true;
  });
});

test('cleanup discovery reports a safe stage without replacing its failure', async () => {
  const failure = Object.freeze(Object.assign(new Error('private registry SQL'), { code: '55P03' }));
  const cleanup = createTableCleanupMaintenance(
    {
      query: async () => {
        throw failure;
      },
    },
    async () => assert.fail('discovery failure must not attempt workspace cleanup'),
  );
  await assert.rejects(cleanup.sweep(), error => {
    assert.equal(error, failure);
    assert.deepEqual(errorAttributes(error), {
      'error.type': 'Error',
      'error.stage': 'table-cleanup-discovery',
      'error.code': '55P03',
      'error.reason': 'Database lock could not be acquired',
    });
    return true;
  });
});
