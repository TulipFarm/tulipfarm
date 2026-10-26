import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageUnavailableError, transientStorageError } from '../src/runtime.ts';

const failure = (code, message = 'storage failed') => Object.assign(new Error(message), { code });

test('lock, statement and connection timeouts, conflicts and dropped connections are transient', () => {
  for (const code of ['40001', '40P01', '55P03', '57014', '08006', '57P01', 'ECONNRESET', 'ETIMEDOUT'])
    assert.equal(transientStorageError(failure(code)), true, code);
  for (const message of ['timeout exceeded when trying to connect', 'Connection terminated unexpectedly'])
    assert.equal(transientStorageError(new Error(message)), true, message);
  for (const code of ['queue_full', 'wait_timeout', 'pool_capacity', 'stale_credential'])
    assert.equal(transientStorageError(new StorageUnavailableError(code)), true, code);
});

test('closed or incompatible storage, data errors and non-errors are not transient', () => {
  for (const code of ['closed', 'incompatible_version', 'disabled'])
    assert.equal(transientStorageError(new StorageUnavailableError(code)), false, code);
  for (const code of ['23505', '42P01', '22P02']) assert.equal(transientStorageError(failure(code)), false, code);
  for (const value of [new Error('access-denied'), undefined, null, '55P03', { code: 55 }])
    assert.equal(transientStorageError(value), false, String(value));
});
