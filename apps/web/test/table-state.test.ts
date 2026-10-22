import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginRead, failedRead, failedWrite, TableRequestError } from '../src/features/tables/request-state.ts';

test('refresh retains existing rows and a failed refresh leaves them usable', () => {
  const data = [{ id: 'record-1', name: 'Acme' }];
  const refreshing = beginRead({ kind: 'ready', data, refreshing: false, error: null });
  assert.deepEqual(refreshing, { kind: 'ready', data, refreshing: true, error: null });
  assert.deepEqual(failedRead(refreshing, new TableRequestError(503, 'maintenance', 'Try again later')), {
    kind: 'ready',
    data,
    refreshing: false,
    error: 'Try again later',
  });
});

test('initial failures never become empty success and retry is loading', () => {
  const failed = failedRead({ kind: 'loading' }, new TableRequestError(503, 'unavailable', 'Try again'));
  assert.deepEqual(failed, { kind: 'error', message: 'Try again' });
  assert.deepEqual(beginRead(failed), { kind: 'loading' });
});

test('lost access discards previously visible rows', () => {
  for (const status of [401, 403, 404]) {
    assert.deepEqual(
      failedRead(
        { kind: 'ready', data: ['private row'], refreshing: true, error: null },
        new TableRequestError(status, 'unavailable', 'Unavailable'),
      ),
      {
        kind: 'unavailable',
        status,
      },
    );
  }
});

test('uncertain writes retain the exact input and request identity', () => {
  const input = { requestId: 'same-request', values: { name: 'Unsaved input' } };
  for (const error of [new Error('network lost'), new TableRequestError(503, 'busy', 'Busy')]) {
    const failed = failedWrite(input, error);
    assert.equal(failed.kind, 'uncertain');
    if (failed.kind === 'uncertain') assert.strictEqual(failed.input, input);
  }
  assert.deepEqual(failedWrite(input, new TableRequestError(409, 'conflict', 'Refresh the saved revision')), {
    kind: 'rejected',
    message: 'Refresh the saved revision',
  });
});
