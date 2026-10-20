import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationError } from '../src/operation-contracts.ts';

test('OperationError runs through native Node TypeScript without parameter-property transforms', () => {
  const error = new OperationError('operation-approval-required');
  assert.equal(error.code, 'operation-approval-required');
  assert.equal(error.message, 'operation-approval-required');
  assert.ok(error instanceof Error);
});
